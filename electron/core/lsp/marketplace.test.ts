import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  detectStandaloneServer,
  LicenseGatedServerError,
  LspMarketplace,
  marketplaceExtension,
  parseSearchResponse,
  pickVersion,
  platformKey,
  type InstalledLspRecord,
} from "./marketplace";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jin-marketplace-"));
  roots.push(root);
  return root;
}

function installedRecord(overrides: Partial<InstalledLspRecord> = {}): InstalledLspRecord {
  return {
    id: "ms-python.vscode-pylance",
    publisher: "ms-python",
    name: "vscode-pylance",
    displayName: "Pylance",
    version: "1.0.0",
    installedAt: "2026-01-01T00:00:00.000Z",
    directory: "/tmp/pylance",
    kind: "node",
    entry: "dist/server.bundle.js",
    args: ["--stdio"],
    language: "Python",
    extensions: [".py"],
    ...overrides,
  };
}

function galleryExtension() {
  return {
    publisher: {
      publisherName: "ms-python",
      displayName: "Microsoft",
      flags: "verified",
      isDomainVerified: true,
    },
    extensionName: "vscode-pylance",
    displayName: "Pylance",
    shortDescription: "Fast Python language server",
    lastUpdated: "2026-02-02T00:00:00.000Z",
    versions: [
      {
        version: "2.0.0",
        lastUpdated: "2026-02-02T00:00:00.000Z",
        files: [
          {
            assetType: "Microsoft.VisualStudio.Services.Icons.Default",
            source: "https://example.test/icon.png",
          },
          {
            assetType: "Microsoft.VisualStudio.Services.VSIXPackage",
            source: "https://example.test/extension.vsix",
          },
        ],
      },
      {
        version: "2.0.1",
        targetPlatform: "linux-x64",
        lastUpdated: "2026-02-03T00:00:00.000Z",
        files: [
          {
            assetType: "Microsoft.VisualStudio.Services.Icons.Default",
            source: "https://example.test/icon.png",
          },
        ],
      },
    ],
    statistics: [
      { statisticName: "install", value: 1234 },
      { statisticName: "averagerating", value: 4.7 },
    ],
  };
}

describe("Marketplace metadata", () => {
  it("prefers an exact platform build and falls back to a universal build", () => {
    expect(platformKey("linux", "x64")).toBe("linux-x64");
    expect(
      pickVersion(
        [
          { version: "universal" },
          { version: "linux", targetPlatform: "linux-x64" },
        ],
        "linux-x64",
      )?.version,
    ).toBe("linux");
    expect(
      pickVersion([{ version: "universal" }], "darwin-arm64")?.version,
    ).toBe("universal");
    expect(
      pickVersion(
        [{ version: "other", targetPlatform: "win32-x64" }],
        "linux-x64",
      )?.version,
    ).toBe("other");
    expect(pickVersion([], "linux-x64")).toBeNull();
  });

  it("maps gallery rows to the renderer shape", () => {
    const extension = marketplaceExtension(
      galleryExtension(),
      undefined,
      "linux-x64",
    );

    expect(extension).toEqual(
      expect.objectContaining({
        id: "ms-python.vscode-pylance",
        publisher: "ms-python",
        name: "vscode-pylance",
        displayName: "Pylance",
        description: "Fast Python language server",
        version: "2.0.1",
        installs: 1234,
        rating: 4.7,
        iconUrl: "https://example.test/icon.png",
        verified: true,
        installed: false,
      }),
    );
    expect(extension?.installedVersion).toBeUndefined();
  });

  it("marks installed extensions and reports their registered entry", () => {
    const extension = marketplaceExtension(
      galleryExtension(),
      installedRecord(),
      "linux-x64",
    );

    expect(extension?.installed).toBe(true);
    expect(extension?.installedVersion).toBe("1.0.0");
    expect(extension?.server).toBe("dist/server.bundle.js");
  });

  it("parses the result count and per-extension installed state", () => {
    const result = parseSearchResponse(
      {
        results: [
          {
            extensions: [galleryExtension()],
            resultMetadata: [
              {
                metadataType: "ResultCount",
                metadataItems: [{ name: "TotalCount", count: 42 }],
              },
            ],
          },
        ],
      },
      [installedRecord()],
      "linux-x64",
    );

    expect(result.total).toBe(42);
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0]?.installed).toBe(true);
    expect(result.extensions[0]?.version).toBe("2.0.1");
  });
});

describe("detectStandaloneServer", () => {
  it("recognizes a known Node language-server entry", () => {
    const root = tempRoot();
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "server.js"), "// bundle", "utf8");

    expect(
      detectStandaloneServer(root, {}, "ms-pyright.pyright"),
    ).toEqual({
      entry: "dist/server.js",
      kind: "node",
      args: ["--stdio"],
      language: "Python",
      extensions: [".py", ".pyi"],
    });
  });

  it("refuses license-gated servers without downloading the VSIX", async () => {
    const marketplace = new LspMarketplace(tempRoot());
    await expect(
      marketplace.install("ms-python.vscode-pylance"),
    ).rejects.toBeInstanceOf(LicenseGatedServerError);
  });

  it("finds a server binary from contributed languages", () => {
    const root = tempRoot();
    mkdirSync(join(root, "server"), { recursive: true });
    writeFileSync(join(root, "server", "rust-analyzer"), "binary", "utf8");

    expect(
      detectStandaloneServer(
        root,
        {
          contributes: {
            languages: [{ id: "rust", extensions: [".rs"] }],
          },
        },
        "someone.rust-analyzer",
      ),
    ).toEqual({
      entry: "server/rust-analyzer",
      kind: "binary",
      args: [],
      language: "rust",
      extensions: [".rs"],
    });
  });

  it("never treats the extension activation bundle as a language server", () => {
    const root = tempRoot();
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "dist", "extension.js"), "// activation", "utf8");

    expect(
      detectStandaloneServer(
        root,
        {
          main: "./dist/extension.js",
          contributes: {
            languages: [
              { id: "python", aliases: ["Python"], extensions: [".py"] },
            ],
          },
        },
        "publisher.ordinary-extension",
      ),
    ).toBeNull();
  });
});
