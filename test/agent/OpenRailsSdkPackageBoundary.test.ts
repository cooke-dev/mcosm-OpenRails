import { expect } from "chai";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const ROOT = path.resolve(__dirname, "..", "..");
const SDK = path.join(ROOT, "sdk");

function readJson(relativePath: string): any {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

// The OpenRails Agent layer is exported through ONE consolidated subpath, `openrails-sdk/agent`
// (a barrel over chains/manifest/discovery/provider/conformance) — deliberately different from
// the successor repo's five separate subpaths, so the agent layer can never leak into the root
// `openrails-sdk` import and stays a single, clearly-bounded surface. See docs/agent/README.md.
describe("OpenRails SDK npm package boundary (agent layer)", () => {
  it("declares the root barrel unchanged and one consolidated ./agent export subpath", () => {
    const pkg = readJson("sdk/package.json");

    expect(pkg.name).to.equal("openrails-sdk");
    expect(pkg.private).to.not.equal(true);
    expect(pkg.main).to.equal("dist/index.js");
    expect(pkg.types).to.equal("dist/index.d.ts");
    expect(pkg.exports["."]).to.deep.equal({ types: "./dist/index.d.ts", default: "./dist/index.js" });
    expect(pkg.exports["./agent"]).to.deep.equal({ types: "./dist/agent/index.d.ts", default: "./dist/agent/index.js" });
  });

  it("builds dist files importable through the ./agent boundary, and never through the root", () => {
    execFileSync("npm", ["run", "build"], { cwd: SDK, stdio: "pipe" });

    const root = require(path.join(SDK, "dist", "index.js"));
    const agent = require(path.join(SDK, "dist", "agent", "index.js"));

    expect(agent.OPENRAILS_CHAINS["arc-testnet"].chainId).to.equal(5042002);
    expect(agent.validateOpenRailsSurfaceManifest).to.be.a("function");
    expect(agent.buildOpenRailsMarketplaceToolFixture().tools).to.have.length(8);
    expect(agent.createOpenRailsProviderMiddleware).to.be.a("function");
    expect(agent.buildOpenRailsMarketplaceIndex).to.be.a("function");

    // The root barrel must never re-export agent-layer symbols.
    expect(root.OPENRAILS_CHAINS).to.equal(undefined);
    expect(root.buildOpenRailsMarketplaceIndex).to.equal(undefined);
  });

  it("npm pack dry-run includes the agent dist output but no src/ or test/", () => {
    execFileSync("npm", ["run", "build"], { cwd: SDK, stdio: "pipe" });
    const output = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: SDK, encoding: "utf8" });
    const [pack] = JSON.parse(output);
    const files = pack.files.map((file: { path: string }) => file.path).sort();

    expect(files).to.include("package.json");
    expect(files).to.include("README.md");
    expect(files).to.include("dist/index.js");
    expect(files).to.include("dist/agent/index.js");
    expect(files).to.include("dist/agent/chains.js");
    expect(files).to.include("dist/agent/manifest.js");
    expect(files).to.include("dist/agent/discovery.js");
    expect(files).to.include("dist/agent/provider.js");
    expect(files).to.include("dist/agent/conformance.js");
    expect(files.some((file: string) => file.startsWith("src/"))).to.equal(false);
    expect(files.some((file: string) => file.startsWith("../test/"))).to.equal(false);
  });
});
