import { spawn } from 'child_process'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { dirname } from 'path'
import type { ConsoleMessage } from 'playwright-chromium'
import { runCommand, sleep, logProgress, cliConfig, humanizeTime } from './utils'
import fetch_ from 'node-fetch'
import { assert } from './utils'
import { Logs } from './Logs'
import stripAnsi from 'strip-ansi'
import { editFileAssertReverted, editFileRevert } from './editFile'
import { getCurrentTest } from './getCurrentTest'
import { page } from './page'

export { partRegex } from '@brillout/part-regex'
export { autoRetry }
export { fetchHtml }
export { fetch }
export { expectError } from './Logs'
export { run }
export { skip }
export { isMinNodeVersion }
export { isGithubAction }
export { isLinux }
export { isWindows }
export { isMac }
export { sleep }
export let urlBase = 'http://localhost:3000'
export const urlBaseChange = (url: string) => (urlBase = url)
export { editFile, editFileRevert } from './editFile'

const TIMEOUT_NPM_SCRIPT = 2 * 60 * 1000
const TIMEOUT_TEST_FUNCTION = 60 * 1000 * (!isGithubAction() ? 1 : isWindows() ? 5 : 3)
const TIMEOUT_PROCESS_TERMINATION = 10 * 1000 * (!isGithubAction() ? 1 : isLinux() ? 1 : 4)
const TIMEOUT_AUTORETRY = TIMEOUT_TEST_FUNCTION / 2
const TIMEOUT_PLAYWRIGHT = TIMEOUT_TEST_FUNCTION / 2

function skip(reason: string) {
  const testInfo = getCurrentTest()
  testInfo.skipped = reason
}

function run(
  cmd: string,
  {
    //baseUrl = '',
    additionalTimeout = 0,
    serverIsReadyMessage,
    serverIsReadyDelay = 1000,
    inspect = cliConfig.inspect,
    cwd,
    onlyFailOnBrowserError = false,
  }: {
    //baseUrl?: string
    additionalTimeout?: number
    serverIsReadyMessage?: string
    serverIsReadyDelay?: number
    inspect?: boolean
    cwd?: string
    onlyFailOnBrowserError?: boolean
  } = {}
) {
  additionalTimeout += serverIsReadyDelay

  const testInfo = getCurrentTest()
  testInfo.runInfo = {
    cmd,
    cwd: cwd || getCwd(),
    additionalTimeout,
    testFunctionTimeout: TIMEOUT_TEST_FUNCTION + additionalTimeout,
    serverIsReadyMessage,
    serverIsReadyDelay,
    inspect,
    onlyFailOnBrowserError,
  }

  if (inspect) {
    Logs.flushEagerly = true
  }

  let runProcess: RunProcess | null = null
  testInfo.startServer = async () => {
    runProcess = await start()

    page.on('console', onConsole)
    page.on('pageerror', onPageError)

    // This setting will change the default maximum time for all the methods accepting timeout option.
    // https://playwright.dev/docs/api/class-page#page-set-default-timeout
    page.setDefaultTimeout(TIMEOUT_PLAYWRIGHT + additionalTimeout)

    /*
    await bailOnTimeout(
      async () => {
        await page.goto(urlBase + baseUrl)
      },
      { timeout: TIMEOUT_PAGE_LOAD + additionalTimeout },
    )
    */
  }
  testInfo.afterEach = (hasFailed: boolean) => {
    if (!hasFailed) {
      editFileAssertReverted()
    } else {
      editFileRevert()
    }
  }
  testInfo.terminateServer = async () => {
    page.off('console', onConsole)
    page.off('pageerror', onPageError)

    // `runProcess` is `undefined` if `start()` failed.
    if (runProcess) {
      await runProcess.terminate('SIGINT')
    }
  }

  return

  // Also called when the page throws an error or a warning
  function onConsole(msg: ConsoleMessage) {
    const type = msg.type()
    Logs.add({
      logSource: (() => {
        if (type === 'error') {
          return 'Browser Error'
        }
        if (type === 'warning') {
          return 'Browser Warning'
        }
        return 'Browser Log'
      })(),
      logText: JSON.stringify(
        {
          type,
          text: msg.text(),
          location: msg.location(),
          args: msg.args(),
        },
        null,
        2
      ),
    })
  }
  // For uncaught exceptions
  function onPageError(err: Error) {
    Logs.add({
      logSource: 'Browser Error',
      logText: JSON.stringify(
        {
          text: err.message,
          location: err.stack,
        },
        null,
        2
      ),
    })
  }
}

function getRunInfo() {
  const testInfo = getCurrentTest()
  assert(testInfo.runInfo)
  return testInfo.runInfo
}

type RunProcess = {
  terminate: (signal: 'SIGINT' | 'SIGKILL') => Promise<void>
}
async function start(): Promise<RunProcess> {
  const { cmd, additionalTimeout, serverIsReadyMessage, serverIsReadyDelay } = getRunInfo()
  const done = logProgress(`| [run] ${cmd}`)

  let hasSuccessfullyStarted = false
  let resolveServerStart: () => void
  let rejectServerStart: (err: Error) => void
  const promise = new Promise<RunProcess>((_resolve, _reject) => {
    resolveServerStart = () => {
      assert(!processHasExited())
      assert(getRunInfo().cmd === cmd)
      Logs.add({
        logSource: 'run()',
        logText: 'server is ready',
      })
      hasSuccessfullyStarted = true
      clearTimeout(serverStartTimeout)
      const runProcess = { terminate }
      _resolve(runProcess)
    }
    rejectServerStart = async (err: Error) => {
      assert(processHasExited())
      assert(getRunInfo().cmd === cmd)
      done(true)
      clearTimeout(serverStartTimeout)
      _reject(err)
    }
  })

  const timeoutTotal = TIMEOUT_NPM_SCRIPT + additionalTimeout
  let hasTimedout = false
  const serverStartTimeout = setTimeout(async () => {
    hasTimedout = true
    let errMsg = ''
    errMsg += `Server still didn't start after ${humanizeTime(timeoutTotal)} of running the npm script \`${cmd}\`.`
    if (serverIsReadyMessage) {
      errMsg += ` (The stdout of the npm script did not include: "${serverIsReadyMessage}".)`
    }
    Logs.add({
      logSource: 'run() failure',
      logText: errMsg,
    })
    await terminate()
    rejectServerStart(new Error(errMsg))
  }, timeoutTotal)

  // Kill any process that listens to port `3000`
  if (!process.env.CI && isLinux()) {
    await runCommand('fuser -k 3000/tcp', { swallowError: true, timeout: 10 * 1000 })
  }

  const { terminate, processHasExited } = execRunScript({
    async onFailure(err) {
      assert(processHasExited())
      rejectServerStart(err as Error)
    },
    onExit() {
      assert(processHasExited())
      const exitIsPossible = hasSuccessfullyStarted === true || hasTimedout
      return exitIsPossible
    },
    async onStdout(data: string) {
      const text = stripAnsi(data)
      const isServerReady =
        // Custom
        (serverIsReadyMessage && text.includes(serverIsReadyMessage)) ||
        // Express.js server
        text.includes('Server running at') ||
        // npm package `serve`
        text.includes('Accepting connections at') ||
        // Vite
        (text.includes('Local:') && text.includes('http://localhost:3000/'))
      if (isServerReady) {
        assert(serverIsReadyDelay)
        await sleep(serverIsReadyDelay)
        resolveServerStart()
        done()
      }
    },
  })

  return promise
}

function stopProcess({
  proc,
  cwd,
  cmd,
  signal,
}: {
  proc: ChildProcessWithoutNullStreams
  cwd: string
  cmd: string
  signal: 'SIGINT' | 'SIGKILL'
}) {
  const prefix = `[Run Stop][${cwd}][${cmd}]`

  let resolve: () => void
  let reject: (err: Error) => void
  const promise = new Promise<void>((_resolve, _reject) => {
    resolve = _resolve
    reject = _reject
  })

  const onProcessClose = (code: number) => {
    if (code === 0 || code === null || (code === 1 && isWindows())) {
      resolve()
    } else {
      reject(new Error(`${prefix} Terminated with non-0 error code ${code}`))
    }
  }
  proc.on('close', onProcessClose)
  proc.on('exit', onProcessClose)
  if (isWindows()) {
    // - https://github.com/nodejs/node/issues/3617#issuecomment-377731194
    // - https://stackoverflow.com/questions/23706055/why-can-i-not-kill-my-child-process-in-nodejs-on-windows/28163919#28163919
    spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], {
      stdio: [
        'ignore', // stdin
        'ignore', // stdout
        // Should we ignore `stderr`? Because `taskkill` somtimes throws:
        // ```
        // ERROR: The process with PID 6052 (child process of PID 3184) could not be terminated.
        // Reason: There is no running instance of the task.
        // ```
        // There doesn't seem to be an option to suppress that error: https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill#parameters
        'inherit', // stderr
      ],
    })
  } else {
    assert(proc.pid)
    const processGroup = -1 * proc.pid
    process.kill(processGroup, signal)
    /*
      try {
        process.kill(-proc.pid, signal)
      } catch (err: unknown) {
        // ESRCH: No process or process group can be found corresponding to that specified by pid.
        //  => probably means that the process was killed already.
        if (typeof err === 'object' && err !== null && 'code' in err && err['code'] === 'ESRCH') {
          printLog('stdout', '=============== swallowError')
          return
        } else {
          printLog('stdout', '=============== no swallowError')
          throw err
        }
      }
      */
  }

  return promise
}

function execRunScript({
  onStdout,
  onFailure,
  onExit,
}: {
  onStdout?: (data: string) => void | Promise<void>
  onFailure: (err: Error) => void | Promise<void>
  onExit: () => boolean
}) {
  const { cwd, cmd } = getRunInfo()
  let [command, ...args] = cmd.split(' ')
  let detached = true
  if (isWindows()) {
    detached = false
    if (command === 'npm' || command === 'pnpm') {
      command = command + '.cmd'
    }
  }
  Logs.add({
    logSource: 'run()',
    logText: `Spawn command \`${cmd}\``,
  })
  const proc = spawn(command, args, { cwd, detached })

  let procExited = false

  const exitAndFail = async (err: Error) => {
    Logs.add({
      logText: err.message,
      logSource: 'run() failure',
    })
    await terminate()
    onFailure(err)
  }

  proc.stdin.on('data', async (data: string) => {
    await exitAndFail(new Error(`Command is \`${cmd}\` (${cwd}) is invoking \`stdin\`: ${data}.`))
  })
  proc.stdout.on('data', (data: string) => {
    assert(!procExited)
    assert(getRunInfo().cmd === cmd)
    data = data.toString()
    Logs.add({
      logSource: 'stdout',
      logText: data,
    })
    onStdout?.(data)
  })
  proc.stderr.on('data', async (data) => {
    assert(!procExited)
    assert(getRunInfo().cmd === cmd)
    data = data.toString()
    Logs.add({
      logSource: 'stderr',
      logText: data,
    })
    if (data.includes('EADDRINUSE')) {
      await exitAndFail(new Error('Port conflict? Port already in use EADDRINUSE.'))
    }
  })
  proc.on('exit', (code) => {
    procExited = true
    assert(getRunInfo().cmd === cmd)
    const exitIsPossible = onExit()
    const isSuccessCode = [0, null].includes(code) || (isWindows() && code === 1)
    const isExpected = isSuccessCode && exitIsPossible
    if (!isExpected) {
      const errMsg = `Unexpected premature process termination, exit code: ${code}`
      Logs.add({
        logText: errMsg,
        logSource: 'run() failure',
      })
      onFailure(new Error(errMsg))
    } else {
      Logs.add({
        logText: `Process termination. (Nominal, exit code: ${code}.)`,
        logSource: 'run()',
      })
    }
  })

  return { terminate, processHasExited }

  function processHasExited(): boolean {
    return procExited
  }

  async function terminate(signal: 'SIGINT' | 'SIGKILL' = 'SIGKILL') {
    let resolve!: () => void
    let reject!: (err: Error) => void
    const promise = new Promise<void>((_resolve, _reject) => {
      resolve = _resolve
      reject = _reject
    })

    const timeout = setTimeout(() => {
      const errMsg = 'Process termination timeout. Cmd: ' + cmd
      Logs.add({
        logSource: 'run() failure',
        logText: errMsg,
      })
      reject(new Error(errMsg))
    }, TIMEOUT_PROCESS_TERMINATION)

    assert(proc)
    try {
      await stopProcess({
        proc,
        cwd,
        cmd,
        signal,
      })
    } catch (err) {
      Logs.add({
        logSource: 'run() failure',
        logText: String(err),
      })
    }
    clearTimeout(timeout)
    resolve()

    return promise
  }
}

async function autoRetry(
  test: () => void | Promise<void>,
  { timeout = TIMEOUT_AUTORETRY }: { timeout?: number } = {}
): Promise<void> {
  const period = 100
  const numberOfTries = timeout / period
  let i = 0
  while (true) {
    try {
      await test()
      return
    } catch (err) {
      i = i + 1
      if (i > numberOfTries) {
        throw err
      }
    }
    await sleep(period)
  }
}

async function fetchHtml(pathname: string) {
  const response = await fetch(urlBase + pathname)
  const html = await response.text()
  return html
}
async function fetch(...args: Parameters<typeof fetch_>) {
  try {
    return await fetch_(...args)
  } catch (err) {
    Logs.add({
      logSource: 'Connection Error',
      logText: `Couldn't connect to \`${args[0]}\`. Args: \`${JSON.stringify(args.slice(1))}\`. Err: \`${
        // @ts-ignore
        err.message
      }\``,
    })
    throw new Error("Couldn't connect to server. See `Connection Error` log for more details.")
  }
}

/*
async function bailOnTimeout(asyncFunc: () => Promise<void>, { timeout }: { timeout: number }) {
  let resolve: () => void
  let reject: (err: Error) => void
  const promise = new Promise<void>((_resolve, _reject) => {
    resolve = _resolve
    reject = _reject
  })

  const t = setTimeout(() => {
    reject(new Error(`Function timeout.`))
  }, timeout)
  await asyncFunc()
  clearTimeout(t)
  resolve()

  return promise
}
*/

function isMinNodeVersion(minNodeVersion: 14) {
  const { version } = process
  assert(version.startsWith('v'))
  const major = parseInt(version[1] + version[2], 10)
  assert(12 <= major && major <= 50)
  return major >= minNodeVersion
}

function isWindows() {
  return process.platform === 'win32'
}
function isLinux() {
  return process.platform === 'linux'
}
function isMac() {
  if (process.platform === 'darwin') {
    return true
  }
  assert(isLinux() || isWindows())
  return false
}
function isGithubAction() {
  return !!process.env.CI
}

function getCwd() {
  const { testFile } = getCurrentTest()
  const cwd = dirname(testFile)
  return cwd
}
