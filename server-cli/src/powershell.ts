// Running a small PowerShell script as a child process (Windows). Node has no FFI, so the few Win32 calls
// the CLI needs (SetThreadExecutionState) and the network counters go through Windows PowerShell 5.1,
// which every Windows 10/11 has.

/** Windows PowerShell by full path (not whatever `powershell` is first on PATH). */
export function powershellExe(env: NodeJS.ProcessEnv = process.env): string {
  return env.SystemRoot ? `${env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : 'powershell.exe'
}

/** Arguments that run `script` without profiles or prompts (-EncodedCommand: no quoting issues). */
export function powershellArgs(script: string): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]
}
