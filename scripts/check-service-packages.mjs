import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "hyperflip-packages-"));
const loader = join(root, "writer/node_modules/tsx/dist/loader.mjs");
try {
  for (const service of ["keeper", "writer"]) {
    const archive = join(temporary, `${service}.tar.gz`);
    execFileSync("tar", ["-czf", archive, "-C", root, ...["package.json", "package-lock.json", "tsconfig.json", "src", "abi"].map(path => `${service}/${path}`), "registry/deployment.mts", "registry/deployment.testnet.json", "services/files.mts"]);
    const destination = join(temporary, service);
    execFileSync("tar", ["-xzf", archive, "-C", temporary]);
    assert(!existsSync(join(destination, "out")));
    assert(existsSync(join(destination, "package-lock.json")));
    const module = pathToFileURL(join(destination, "src/abi.ts")).href;
    execFileSync(process.execPath, ["--import", loader, "--input-type=module", "-e", `
      import assert from "node:assert/strict";
      const abis = await import(${JSON.stringify(module)});
      assert.equal(Object.keys(abis).length, 2);
      for (const abi of Object.values(abis)) assert(Array.isArray(abi) && abi.length > 0);
      const { loadDeployment } = await import(${JSON.stringify(pathToFileURL(join(temporary, "registry/deployment.mts")).href)});
      assert.equal(loadDeployment({}).chainId, 998);
      const files = await import(${JSON.stringify(pathToFileURL(join(temporary, "services/files.mts")).href)});
      assert.equal(typeof files.replaceFile, "function");
    `], { env: { ...process.env, PATH: dirname(process.execPath) }, stdio: "pipe" });
    console.log(`PASS: packed ${service} imports its ABIs without out/ or Foundry`);
  }

  execFileSync(process.execPath, ["--import", loader, "--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { readFileSync } from "node:fs";
    const imported = await import(${JSON.stringify(pathToFileURL(join(root, "web/lib/contracts.ts")).href)});
    const web = imported.default ?? imported;
    const read = name => JSON.parse(readFileSync(${JSON.stringify(join(root, "writer/abi"))} + "/" + name + ".json", "utf8"));
    const fields = items => (items ?? []).map(item => [item.type, !!item.indexed, fields(item.components)]);
    const shape = item => JSON.stringify([item.type, item.name, item.stateMutability, fields(item.inputs), fields(item.outputs)]);
    for (const [subset, name] of [[web.parlayVaultAbi, "ParlayVault"], [[web.parlayMintedEvent], "ParlayVault"], [web.outcomeVaultAbi, "OutcomeVault"]]) {
      const full = new Set(read(name).map(shape));
      for (const item of subset) assert(full.has(shape(item)), name + " frontend ABI mismatch: " + item.name);
    }
  `], { env: { ...process.env, NEXT_PUBLIC_PARLAY_DEPLOY_BLOCK: "1", NEXT_PUBLIC_PARLAY_VAULT: "0x1111111111111111111111111111111111111111" }, stdio: "pipe" });
  console.log("PASS: frontend interfaces match generated contract ABIs");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
