import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isBuiltin } from "node:module";
import ts from "typescript";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const ignored = new Set(["node_modules", "dist", ".git"]);

function files(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (ignored.has(entry.name)) return [];
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error("Symlink in workspace source tree");
    if (entry.isDirectory()) return files(full);
    if (!entry.isFile())
      throw new Error("Non-regular file in workspace source tree");
    return [full];
  });
}

function section(text, heading) {
  const value = text.replace(/\r\n/g, "\n").split(`## ${heading}\n`)[1];
  if (!value) throw new Error(`Missing module-map section: ${heading}`);
  return value.split("\n## ")[0];
}

export function checkBoundaries(root = repositoryRoot) {
  root = realpathSync(root);
  const document = readFileSync(path.join(root, "docs/MODULES.md"), "utf8");
  const locations = [];
  const allowed = new Map();
  for (const line of section(
    document,
    "Target directory and ownership map",
  ).split("\n")) {
    if (!line.startsWith("| `")) continue;
    const cells = line.split("|");
    const module = cells[1].trim().replaceAll("`", "");
    for (const match of cells[2].matchAll(/`([^`]+\/)`/g)) {
      locations.push({ module, directory: path.resolve(root, match[1]) });
    }
  }
  for (const line of section(document, "Dependency rules").split("\n")) {
    if (!line.startsWith("| `")) continue;
    const cells = line.split("|");
    allowed.set(
      cells[1].trim().replaceAll("`", ""),
      [...cells[2].matchAll(/`([^`]+)`/g)].map((match) => match[1]),
    );
  }
  const within = (file, directory) => file.startsWith(directory + path.sep);
  const owner = (file) =>
    locations.find((entry) => within(file, entry.directory));
  const allFiles = ["apps", "packages"].flatMap((directory) =>
    files(path.join(root, directory)),
  );
  const packages = new Map();
  for (const file of allFiles.filter(
    (file) => path.basename(file) === "package.json",
  )) {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    const location = owner(file);
    if (
      !location ||
      path.dirname(file) !== location.directory ||
      packages.has(manifest.name)
    ) {
      throw new Error("Unmapped, nested or duplicate workspace package");
    }
    packages.set(manifest.name, { ...location, manifest });
  }
  const workspacePaths = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  ).workspaces;
  if (
    !Array.isArray(workspacePaths) ||
    new Set(workspacePaths).size !== workspacePaths.length ||
    workspacePaths.length !== packages.size ||
    workspacePaths.some(
      (directory) =>
        ![...packages.values()].some(
          (entry) => entry.directory === path.resolve(root, directory),
        ),
    )
  ) {
    throw new Error("Workspace membership differs from mapped packages");
  }
  for (const source of packages.values()) {
    for (const name of Object.keys({
      ...source.manifest.dependencies,
      ...source.manifest.devDependencies,
      ...source.manifest.optionalDependencies,
      ...source.manifest.peerDependencies,
    })) {
      const target = packages.get(name);
      if (target && !allowed.get(source.module)?.includes(target.module)) {
        throw new Error(
          `Prohibited manifest dependency: ${source.module} -> ${target.module}`,
        );
      }
    }
  }
  for (const file of allFiles.filter((file) =>
    /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file),
  )) {
    const location = owner(file);
    const source = [...packages.values()].find(
      (entry) => entry.directory === location?.directory,
    );
    if (!source)
      throw new Error("Source in an unmapped or placeholder-only module");
    const runtime = within(file, path.join(source.directory, "src"));
    const dependencies = runtime
      ? source.manifest.dependencies
      : { ...source.manifest.dependencies, ...source.manifest.devDependencies };
    function checkSpecifier(specifier) {
      if (specifier.startsWith(".")) {
        const target = path.resolve(path.dirname(file), specifier);
        const resolved = existsSync(target) ? realpathSync(target) : target;
        if (!within(resolved, source.directory))
          throw new Error("Relative import crosses module boundary");
        return;
      }
      if (isBuiltin(specifier)) {
        if (
          runtime &&
          ["web-portal", "shared-contracts"].includes(source.module)
        )
          throw new Error("Browser-compatible runtime imports a Node builtin");
        if (specifier === "node:module" || specifier === "module")
          throw new Error("Runtime module loader bypass is prohibited");
        return;
      }
      const packageName = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      if (specifier === source.manifest.name) return;
      if (!dependencies || !Object.hasOwn(dependencies, packageName))
        throw new Error(`Undeclared import: ${specifier}`);
      const target = packages.get(packageName);
      const serverContract =
        specifier === "@laita/contracts/server" &&
        ["runtime-foundation", "policy-capability", "api-server"].includes(
          source.module,
        );
      if (
        target &&
        ((specifier !== packageName &&
          !serverContract &&
          !(
            specifier === "@laita/contracts/browser" &&
            source.module === "web-portal"
          )) ||
          !allowed.get(source.module)?.includes(target.module))
      ) {
        throw new Error(
          `Prohibited module import: ${source.module} -> ${target.module}`,
        );
      }
    }
    const tree = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier
      ) {
        checkSpecifier(node.moduleSpecifier.text);
      } else if (ts.isImportTypeNode(node)) {
        if (
          !ts.isLiteralTypeNode(node.argument) ||
          !ts.isStringLiteral(node.argument.literal)
        )
          throw new Error("Nonliteral import type");
        checkSpecifier(node.argument.literal.text);
      } else if (ts.isImportEqualsDeclaration(node)) {
        throw new Error("Use ESM imports, not import-equals");
      } else if (ts.isCallExpression(node)) {
        if (
          ts.isIdentifier(node.expression) &&
          node.expression.text === "require"
        )
          throw new Error("Use ESM imports, not require");
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          if (!node.arguments[0] || !ts.isStringLiteral(node.arguments[0]))
            throw new Error("Nonliteral dynamic import is prohibited");
          checkSpecifier(node.arguments[0].text);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  checkBoundaries();
  console.log("Workspace import and manifest boundaries passed.");
}
