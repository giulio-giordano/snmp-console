/** Build the Bun server as the platform-specific Tauri sidecar executable. */
const rustTarget = Bun.spawnSync(["rustc", "--print", "host-tuple"], {
  stdout: "pipe",
  stderr: "pipe",
});
if (rustTarget.exitCode !== 0) {
  throw new Error(`Could not determine the Rust target triple: ${new TextDecoder().decode(rustTarget.stderr)}`);
}

const hostTriple = new TextDecoder().decode(rustTarget.stdout).trim();
const tauriTriple = Bun.env.TAURI_ENV_TARGET_TRIPLE ?? hostTriple;
if (tauriTriple !== hostTriple) {
  throw new Error(
    `Cross-target sidecar builds are not configured: Tauri target ${tauriTriple} differs from host ${hostTriple}. Build the desktop app natively on the target platform.`,
  );
}

const executableExtension = process.platform === "win32" ? ".exe" : "";
const output = `desktop/src-tauri/binaries/snmp-backend-${tauriTriple}${executableExtension}`;
console.info(`Building Bun SNMP sidecar for ${tauriTriple}`);
const build = Bun.spawnSync(
  ["bun", "build", "--compile", "index.ts", "--outfile", output],
  { stdout: "inherit", stderr: "inherit" },
);
if (build.exitCode !== 0) {
  throw new Error(`Bun sidecar build failed with exit code ${build.exitCode}`);
}
