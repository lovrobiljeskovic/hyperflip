import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(join(tmpdir(), "hyperflip-packages-"));
const loader = join(root, "writer/node_modules/tsx/dist/loader.mjs");
try {
  for (const [service, abiCount] of [["keeper", 2], ["writer", 1]]) {
    const archive = join(temporary, `${service}.tar.gz`);
    execFileSync("tar", ["-czf", archive, "-C", root, ...["package.json", "package-lock.json", "tsconfig.json", "src", "abi"].map(path => `${service}/${path}`), "registry/deployment.mts", "registry/deployment.testnet.json", "services"]);
    const destination = join(temporary, service);
    execFileSync("tar", ["-xzf", archive, "-C", temporary]);
    assert(!existsSync(join(destination, "out")));
    assert(existsSync(join(destination, "package-lock.json")));
    const module = pathToFileURL(join(destination, "src/abi.ts")).href;
    execFileSync(process.execPath, ["--import", loader, "--input-type=module", "-e", `
      import assert from "node:assert/strict";
      const abis = await import(${JSON.stringify(module)});
      assert.equal(Object.keys(abis).length, ${abiCount});
      for (const abi of Object.values(abis)) assert(Array.isArray(abi) && abi.length > 0);
      const { loadDeployment } = await import(${JSON.stringify(pathToFileURL(join(temporary, "registry/deployment.mts")).href)});
      assert([998, 99801].includes(loadDeployment({}).chainId));
      const modules = ${JSON.stringify(readdirSync(join(temporary, "services")).filter(name => name.endsWith(".mts")).map(name => pathToFileURL(join(temporary, "services", name)).href))};
      for (const href of modules) await import(href);
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
    const read = (dir, name) => JSON.parse(readFileSync(${JSON.stringify(root)} + "/" + dir + "/abi/" + name + ".json", "utf8"));
    const fields = items => (items ?? []).map(item => [item.type, !!item.indexed, fields(item.components)]);
    const shape = item => JSON.stringify([item.type, item.name, item.stateMutability, fields(item.inputs), fields(item.outputs)]);
    for (const [subset, dir, name] of [[web.parlayVaultAbi, "writer", "ParlayVault"], [[web.parlayMintedEvent], "writer", "ParlayVault"], [web.outcomeVaultAbi, "keeper", "OutcomeVault"]]) {
      const full = new Set(read(dir, name).map(shape));
      for (const item of subset) assert(full.has(shape(item)), name + " frontend ABI mismatch: " + item.name);
    }
  `], { env: { ...process.env, NEXT_PUBLIC_PARLAY_DEPLOY_BLOCK: "1", NEXT_PUBLIC_PARLAY_VAULT: "0x1111111111111111111111111111111111111111" }, stdio: "pipe" });
  console.log("PASS: frontend interfaces match generated contract ABIs");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
