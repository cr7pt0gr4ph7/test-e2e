export { runAll }

import type { Browser } from 'playwright-chromium'
import { getCurrentTest, type TestInfo } from './getCurrentTest'
import { Logs } from './Logs'
import { assert, assertUsage, humanizeTime, isTTY, isWindows, logProgress } from './utils'
import { type FindFilter, fsWindowsBugWorkaround } from './utils'
import { abortIfParallelCI } from './parallel-ci'
import { setCurrentTest } from './getCurrentTest'
import { getBrowser } from './getBrowser'
import { buildTs } from './buildTs'
import { findTestFiles } from './findTestFiles'
import { loadConfig } from './getConfig'
import { logError } from './logError'
import { hasFail, logFail, logPass, logWarn } from './logTestStatus'

async function runAll(filter: null | FindFilter) {
  await loadConfig()

  const testFiles = await findTestFiles(filter)

  const browser = await getBrowser()

  const failedFirstAttempt: string[] = []
  for (const testFile of testFiles) {
    const success = await buildAndTest(testFile, browser, false)
    if (!success) {
      failedFirstAttempt.push(testFile)
    }
  }

  const failedSecondAttempt: string[] = []
  for (const testFile of failedFirstAttempt) {
    const success = await buildAndTest(testFile, browser, true)
    if (!success) {
      failedSecondAttempt.push(testFile)
    }
  }

  await browser.close()

  const hasFailLog = hasFail()
  const hasFailedTestFile = failedSecondAttempt.length > 0
  if (hasFailedTestFile || hasFailLog) {
    // hasFailedTestFile and hasFailLog are redundant
    //  - When assert.ts calls logFail() this code block isn't run
    assert(hasFailedTestFile && hasFailLog)
    throw new Error('Following tests failed, see logs above for more information.')
  }
}

async function buildAndTest(testFile: string, browser: Browser, isSecondAttempt: boolean): Promise<boolean> {
  assert(testFile.endsWith('.ts'))
  const testFileJs = testFile.replace('.ts', '.mjs')
  assert(testFileJs.endsWith('.mjs'))
  const cleanBuild = await buildTs(testFile, testFileJs)
  setCurrentTest(testFile)
  try {
    await import(fsWindowsBugWorkaround(testFileJs) + `?cacheBuster=${Date.now()}`)
  } finally {
    cleanBuild()
  }
  const success = await runServerAndTests(browser, isSecondAttempt)
  setCurrentTest(null)
  return success
}

async function runServerAndTests(browser: Browser, isSecondAttempt: boolean): Promise<boolean> {
  const testInfo = getCurrentTest()
  // Set when user calls `run()`
  assert(testInfo.runInfo)
  assert(testInfo.startServer)
  assert(testInfo.terminateServer)

  const isFinalAttempt: boolean = isSecondAttempt || !testInfo.runInfo.isFlaky

  const page = await browser.newPage()
  testInfo.page = page

  try {
    await testInfo.startServer()
  } catch (err) {
    logFailure(err, 'an error occurred while starting the server', isFinalAttempt)
    return false
  }

  let success = await runTests(testInfo, isFinalAttempt)

  await testInfo.terminateServer()
  await page.close()
  // Check whether stderr emitted during testInfo.terminateServer()
  if (success) {
    const failOnWarning = true
    if (
      Logs.hasFailLogs(failOnWarning) &&
      // See comments about taskkill in src/setup.ts
      !isWindows()
    ) {
      logFailure(null, `${getErrorType(failOnWarning)} occurred during server termination`, isFinalAttempt)
      success = false
    }
  }

  if (!success && !testInfo.runInfo.isFlaky) abortIfParallelCI()

  if (success) {
    logPass()
  }
  Logs.clearLogs()

  return success
}

async function runTests(testInfo: TestInfo, isFinalAttempt: boolean): Promise<boolean> {
  if (isTTY) {
    console.log()
    console.log(testInfo.testFile)
  }

  // Set when user calls `skip()`
  if (testInfo.skipped) {
    logWarn(testInfo.skipped)
    assertUsage(!testInfo.runInfo, 'You cannot call `run()` after calling `skip()`')
    assertUsage(testInfo.tests === undefined, 'You cannot call `test()` after calling `skip()`')
    return true
  }

  // Set when user calls `run()`
  assert(testInfo.runInfo)
  assert(testInfo.afterEach)
  // Set when user calls `test()`
  assert(testInfo.tests)
  for (const { testDesc, testFn } of testInfo.tests) {
    Logs.add({
      logSource: 'test()',
      logText: testDesc,
    })
    const done = logProgress(`| [test] ${testDesc}`)
    let err: unknown
    try {
      await runTest(testFn, testInfo.runInfo.testFunctionTimeout)
    } catch (err_) {
      err = err_
    }
    done(!!err)
    testInfo.afterEach(!!err)
    {
      const failOnWarning = !testInfo.runInfo.doNotFailOnWarning
      const hasErrorLog = Logs.hasFailLogs(failOnWarning)
      const isFailure = err || hasErrorLog
      if (isFailure) {
        if (err) {
          logFailure(err, `the test "${testDesc}" threw an error`, isFinalAttempt)
        } else if (hasErrorLog) {
          logFailure(
            null,
            `${getErrorType(failOnWarning)} occurred while running the test "${testDesc}"`,
            isFinalAttempt
          )
        } else {
          assert(false)
        }
        return false
      }
    }
    Logs.clearLogs()
  }

  return true
}

function logFailure(err: null | unknown, reason: string, isFinalAttempt: boolean) {
  logFail(reason, isFinalAttempt)
  if (err) {
    logError(err)
  }
  Logs.logErrorsAndWarnings()
  Logs.flushLogs()
}

function getErrorType(failOnWarning: boolean) {
  return !failOnWarning ? 'error(s)' : 'error(s)/warning(s)'
}

function runTest(testFn: Function, testFunctionTimeout: number): Promise<undefined | unknown> {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const promise = new Promise<void>((resolve_, reject_) => {
    resolve = resolve_
    reject = reject_
  })

  const timeout = setTimeout(() => {
    reject(new Error(`[test] Timeout after ${humanizeTime(testFunctionTimeout)}`))
  }, testFunctionTimeout)

  const ret: unknown = testFn()
  ;(async () => {
    try {
      await ret
      resolve()
    } catch (err) {
      reject(err)
    } finally {
      clearTimeout(timeout)
    }
  })()

  return promise
}