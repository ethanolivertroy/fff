#!/usr/bin/env node
/**
 * Self-install support for `pi install git:github.com/ethanolivertroy/fff@...`.
 *
 * Official FFF npm installs get the native libfff_c binary through
 * @ff-labs/fff-bin-* optional npm packages. For Ethan's git-only Pi package
 * path, we keep that binary supply chain on GitHub Releases instead.
 *
 * This script:
 * 1. Ensures the committed fff-node dist exists.
 * 2. Downloads the current commit's platform-specific c-lib release asset into
 *    packages/fff-node/bin/ so fff-node prefers it in dev-workspace mode.
 * 3. Falls back to a local Rust build when a release asset is not available yet.
 */

import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, copyFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const fffNodeDir = join(repoRoot, "packages", "fff-node");
const distEntry = join(fffNodeDir, "dist", "src", "index.js");
const binDir = join(fffNodeDir, "bin");

function log(message) {
  console.log(`[pi-fff git install] ${message}`);
}

function warn(message) {
  console.warn(`[pi-fff git install] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    env: process.env,
  });

  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `:\n${detail}` : ""}`);
  }

  return (result.stdout ?? "").trim();
}

function tryRun(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "pipe",
    env: process.env,
  });
  if (result.status !== 0) return null;
  return (result.stdout ?? "").trim();
}

function readBaseVersion() {
  const cargoToml = readFileSync(join(repoRoot, "crates", "fff-core", "Cargo.toml"), "utf8");
  const match = cargoToml.match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error("Could not read crates/fff-core version");
  return match[1];
}

function bumpPatch(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) throw new Error(`Could not parse base version: ${version}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

function determineReleaseTag() {
  if (process.env.FFF_RELEASE_TAG) return process.env.FFF_RELEASE_TAG;

  const exactTag = tryRun("git", ["describe", "--exact-match", "--tags", "--match", "v*", "HEAD"]);
  if (exactTag && /^v\d/.test(exactTag)) return exactTag;

  const shortSha = tryRun("git", ["rev-parse", "--short", "HEAD"]);
  if (!shortSha) throw new Error("Could not determine git short SHA for release lookup");

  const branch = tryRun("git", ["symbolic-ref", "--short", "HEAD"]);
  const nextVersion = bumpPatch(readBaseVersion());
  const label = !branch || branch === "main" || branch === "fix/download-version" ? "nightly" : "dev";
  return `${nextVersion}-${label}.${shortSha}`;
}

function detectLinuxLibc() {
  const result = spawnSync("ldd", ["--version"], { encoding: "utf8", stdio: "pipe" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.toLowerCase();
  return output.includes("musl") ? "unknown-linux-musl" : "unknown-linux-gnu";
}

function normalizeArch(arch) {
  switch (arch) {
    case "x64":
    case "amd64":
      return "x86_64";
    case "arm64":
      return "aarch64";
    default:
      throw new Error(`Unsupported architecture: ${arch}`);
  }
}

function getTriple() {
  const arch = normalizeArch(process.arch);
  switch (process.platform) {
    case "darwin":
      return `${arch}-apple-darwin`;
    case "linux":
      return `${arch}-${detectLinuxLibc()}`;
    case "win32":
      return `${arch}-pc-windows-msvc`;
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

function getLibExtension() {
  if (process.platform === "darwin") return "dylib";
  if (process.platform === "win32") return "dll";
  return "so";
}

function getLibFilename() {
  return `${process.platform === "win32" ? "" : "lib"}fff_c.${getLibExtension()}`;
}

function assetNameForTriple(triple) {
  return `c-lib-${triple}.${getLibExtension()}`;
}

function download(url, destination, redirects = 0) {
  return new Promise((resolveDownload, rejectDownload) => {
    if (redirects > 5) {
      rejectDownload(new Error(`Too many redirects while downloading ${url}`));
      return;
    }

    const client = url.startsWith("https:") ? https : http;
    const request = client.get(
      url,
      {
        headers: {
          "user-agent": "pi-fff-git-postinstall",
          accept: "application/octet-stream",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;

        if ([301, 302, 303, 307, 308].includes(status) && location) {
          response.resume();
          const nextUrl = new URL(location, url).toString();
          download(nextUrl, destination, redirects + 1).then(resolveDownload, rejectDownload);
          return;
        }

        if (status < 200 || status >= 300) {
          response.resume();
          rejectDownload(new Error(`HTTP ${status} from ${url}`));
          return;
        }

        mkdirSync(dirname(destination), { recursive: true });
        const tmp = `${destination}.tmp-${process.pid}`;
        const file = createWriteStream(tmp, { mode: 0o755 });
        response.pipe(file);
        file.on("finish", () => {
          file.close(() => {
            rmSync(destination, { force: true });
            copyFileSync(tmp, destination);
            rmSync(tmp, { force: true });
            chmodSync(destination, 0o755);
            resolveDownload();
          });
        });
        file.on("error", (error) => {
          rmSync(tmp, { force: true });
          rejectDownload(error);
        });
      },
    );

    request.on("error", rejectDownload);
    request.setTimeout(30_000, () => {
      request.destroy(new Error(`Timed out downloading ${url}`));
    });
  });
}

function copyLocalBuild(libFilename) {
  const candidates = [
    join(repoRoot, "target", "release", libFilename),
    join(repoRoot, "target", "debug", libFilename),
  ];
  const source = candidates.find((candidate) => existsSync(candidate));
  if (!source) return false;
  mkdirSync(binDir, { recursive: true });
  copyFileSync(source, join(binDir, libFilename));
  chmodSync(join(binDir, libFilename), 0o755);
  return true;
}

function ensureDist() {
  if (existsSync(distEntry)) return;

  if (process.env.FFF_SKIP_DIST_BUILD === "1") {
    throw new Error(`Missing ${distEntry}; committed dist is required for git installs`);
  }

  warn("packages/fff-node/dist is missing; attempting local TypeScript build");
  run("npm", ["run", "build", "-w", "@ff-labs/fff-node"], { stdio: "inherit" });

  if (!existsSync(distEntry)) {
    throw new Error(`TypeScript build completed but ${distEntry} is still missing`);
  }
}

async function main() {
  ensureDist();

  const triple = getTriple();
  const libFilename = getLibFilename();
  const destination = join(binDir, libFilename);

  if (existsSync(destination)) {
    log(`native library already present: ${destination}`);
    return;
  }

  const releaseTag = determineReleaseTag();
  const releaseRepo = process.env.FFF_RELEASE_REPO ?? "ethanolivertroy/fff";
  const assetName = assetNameForTriple(triple);
  const url = `https://github.com/${releaseRepo}/releases/download/${encodeURIComponent(releaseTag)}/${assetName}`;

  try {
    log(`downloading ${assetName} from ${releaseRepo}@${releaseTag}`);
    await download(url, destination);
    log(`installed native library: ${destination}`);
    return;
  } catch (error) {
    warn(`release download unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (process.env.FFF_DISABLE_SOURCE_BUILD === "1") {
    throw new Error("Native release asset is unavailable and source build is disabled");
  }

  warn("falling back to local Rust build of fff-c (without zlob, so Zig is not required)");
  run("cargo", ["build", "--release", "-p", "fff-c"], { stdio: "inherit" });

  if (!copyLocalBuild(libFilename)) {
    throw new Error(`Local Rust build finished but ${libFilename} was not found in target/release`);
  }

  log(`installed locally built native library: ${destination}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
