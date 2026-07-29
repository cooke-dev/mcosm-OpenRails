import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { ethers } from "ethers";

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "artifacts",
  "cache",
  "coverage",
  "dist",
  "dist-test",
  "node_modules",
]);

function normalizeKeystoreAddress(
  address: unknown,
): string | null {
  if (typeof address !== "string" || address.length === 0) {
    return null;
  }

  try {
    return ethers.getAddress(
      address.startsWith("0x")
        ? address
        : `0x${address}`,
    );
  } catch {
    return null;
  }
}

function looksLikeKeystore(
  value: unknown,
): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.address === "string" &&
    (
      typeof record.crypto === "object" ||
      typeof record.Crypto === "object"
    )
  );
}

function isCandidateFilename(name: string): boolean {
  return (
    name.startsWith("UTC--") ||
    /\.(json|keystore|wallet)$/i.test(name)
  );
}

async function walk(
  directory: string,
  output: Set<string>,
  depth = 0,
): Promise<void> {
  if (depth > 5) {
    return;
  }

  let entries: fs.Dirent[];

  try {
    entries = await fs.promises.readdir(
      directory,
      { withFileTypes: true },
    );
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        await walk(fullPath, output, depth + 1);
      }

      continue;
    }

    if (
      entry.isFile() &&
      isCandidateFilename(entry.name)
    ) {
      output.add(fullPath);
    }
  }
}

async function findKeystoreCandidates(): Promise<string[]> {
  const explicitPath =
    process.env.OPENRAILS_KEYSTORE_PATH?.trim();

  if (explicitPath) {
    const resolved = path.resolve(explicitPath);

    if (!fs.existsSync(resolved)) {
      throw new Error(
        `OPENRAILS_KEYSTORE_PATH does not exist: ${resolved}`,
      );
    }

    return [resolved];
  }

  const home = os.homedir();

  const roots = [
    path.join(home, ".openrails"),
    path.join(home, ".config", "openrails"),
    path.join(home, ".secrets"),
    path.join(home, ".ethereum", "keystore"),
    path.join(process.cwd(), ".secrets"),
    path.join(process.cwd(), "keystore"),
    path.join(process.cwd(), "wallets"),
    process.cwd(),
  ];

  const candidates = new Set<string>();

  for (const root of roots) {
    await walk(root, candidates);
  }

  return [...candidates].sort();
}

async function promptHidden(
  message: string,
): Promise<string> {
  const stdin = process.stdin;

  if (
    !stdin.isTTY ||
    !process.stdout.isTTY ||
    typeof stdin.setRawMode !== "function"
  ) {
    throw new Error(
      "Interactive password entry requires a TTY. " +
      "Set OPENRAILS_KEYSTORE_PASSWORD for this process only.",
    );
  }

  return new Promise<string>((resolve, reject) => {
    const previousRawMode = stdin.isRaw;
    let value = "";

    const cleanup = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(Boolean(previousRawMode));
      stdin.pause();
    };

    const onData = (chunk: string | Buffer) => {
      const text = String(chunk);

      for (const character of text) {
        if (character === "\u0003") {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Password entry cancelled"));
          return;
        }

        if (
          character === "\r" ||
          character === "\n"
        ) {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }

        if (
          character === "\u007f" ||
          character === "\b"
        ) {
          if (value.length > 0) {
            value = value.slice(0, -1);
          }

          continue;
        }

        value += character;
      }
    };

    process.stdout.write(message);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function readPassword(): Promise<string> {
  const environmentPassword =
    process.env.OPENRAILS_KEYSTORE_PASSWORD;

  delete process.env.OPENRAILS_KEYSTORE_PASSWORD;

  if (environmentPassword) {
    return environmentPassword;
  }

  return promptHidden("Encrypted wallet password: ");
}

export async function loadEncryptedOwnerWallet(
  provider: ethers.Provider,
  expectedAddress: string,
) {
  const normalizedExpected =
    ethers.getAddress(expectedAddress);

  const candidatePaths =
    await findKeystoreCandidates();

  if (candidatePaths.length === 0) {
    throw new Error(
      "No encrypted JSON keystore was found. " +
      "Set OPENRAILS_KEYSTORE_PATH to its exact path.",
    );
  }

  const matchingCandidates: Array<{
    path: string;
    json: string;
  }> = [];

  for (const candidatePath of candidatePaths) {
    try {
      const stat = await fs.promises.stat(candidatePath);

      if (!stat.isFile() || stat.size > 2_000_000) {
        continue;
      }

      const json = await fs.promises.readFile(
        candidatePath,
        "utf8",
      );

      const parsed = JSON.parse(json);

      if (!looksLikeKeystore(parsed)) {
        continue;
      }

      const candidateAddress =
        normalizeKeystoreAddress(parsed.address);

      if (candidateAddress === normalizedExpected) {
        matchingCandidates.push({
          path: candidatePath,
          json,
        });
      }
    } catch {
      // Ignore unreadable and unrelated JSON files.
    }
  }

  if (matchingCandidates.length === 0) {
    throw new Error(
      `No encrypted keystore for ${normalizedExpected} was found. ` +
      "Set OPENRAILS_KEYSTORE_PATH to its exact path.",
    );
  }

  const password = await readPassword();

  for (const candidate of matchingCandidates) {
    try {
      const decrypted =
        await ethers.Wallet.fromEncryptedJson(
          candidate.json,
          password,
        );

      if (
        ethers.getAddress(decrypted.address) !==
        normalizedExpected
      ) {
        continue;
      }

      return {
        wallet: decrypted.connect(provider),
        keystorePath: candidate.path,
      };
    } catch {
      // Try another matching candidate.
    }
  }

  throw new Error(
    "The password did not unlock the expected encrypted wallet.",
  );
}
