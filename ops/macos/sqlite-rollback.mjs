import { createHash } from "node:crypto";
import {
  closeSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  readSync,
  renameSync,
  rmSync,
  fsyncSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { migrations } from "../../packages/persistence/dist/migrations.js";

const [command, databasePath, backupDirectory] = process.argv.slice(2);
const snapshotName = "sqlite-pre-migration.sqlite";
const snapshotMetadataName = "sqlite-pre-migration.json";
const recoveryName = "sqlite-failed-upgrade.sqlite";
const recoveryMetadataName = "sqlite-failed-upgrade.json";
const metadataContract = "sqlite-rollback-artifact.v1";

function fail() {
  process.exit(1);
}

function sha256File(file) {
  const hash = createHash("sha256");
  const descriptor = openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (
      let bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      bytes > 0;
    ) {
      hash.update(buffer.subarray(0, bytes));
      bytes = readSync(descriptor, buffer, 0, buffer.length, null);
    }
  } finally {
    closeSync(descriptor);
  }
  return `sha256:${hash.digest("hex")}`;
}

function sha256Json(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function schemaRows(database) {
  return database
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all();
}

function expectedSchemaDigest(version) {
  const database = new DatabaseSync(":memory:");
  try {
    for (const migration of migrations.slice(0, version)) {
      database.exec(migration.sql);
      database
        .prepare(
          "INSERT INTO schema_migrations (version, checksum) VALUES (?, ?)",
        )
        .run(
          migration.version,
          createHash("sha256").update(migration.sql).digest("hex"),
        );
      database.exec(`PRAGMA user_version = ${migration.version}`);
    }
    return sha256Json(schemaRows(database));
  } finally {
    database.close();
  }
}

function validateAbsolute(value) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r")
  )
    fail();
}

function validateDirectory(directory) {
  validateAbsolute(directory);
  const info = lstatSync(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o777) !== 0o700 ||
    info.uid !== process.getuid()
  )
    fail();
  if (realpathSync(directory) !== directory) fail();
}

function validateFile(file) {
  validateAbsolute(file);
  const info = lstatSync(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    (info.mode & 0o777) !== 0o600 ||
    info.uid !== process.getuid() ||
    realpathSync(file) !== file
  )
    fail();
  return info;
}

function noSidecars(file) {
  for (const suffix of ["-journal", "-wal", "-shm"])
    if (existsSync(`${file}${suffix}`)) fail();
}

function assertQuiescent(file) {
  const database = new DatabaseSync(file, {
    timeout: 0,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
  });
  try {
    database.exec("BEGIN EXCLUSIVE; ROLLBACK");
  } finally {
    if (database.isTransaction) database.exec("ROLLBACK");
    database.close();
  }
  noSidecars(file);
}

function inspectDatabase(file) {
  const info = validateFile(file);
  noSidecars(file);
  const database = new DatabaseSync(file, {
    readOnly: true,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
  });
  try {
    const integrity = database.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok")
      fail();
    const schemaVersion = database
      .prepare("PRAGMA user_version")
      .get()?.user_version;
    if (
      !Number.isSafeInteger(schemaVersion) ||
      schemaVersion < 1 ||
      schemaVersion > migrations.length
    )
      fail();
    const ledger = database
      .prepare(
        "SELECT version, checksum FROM schema_migrations ORDER BY version",
      )
      .all();
    if (
      ledger.length !== schemaVersion ||
      ledger.some(
        (row, index) =>
          row.version !== index + 1 ||
          row.checksum !==
            createHash("sha256").update(migrations[index].sql).digest("hex"),
      )
    )
      fail();
    const schemaDigest = sha256Json(schemaRows(database));
    if (schemaDigest !== expectedSchemaDigest(schemaVersion)) fail();
    return Object.freeze({
      schemaVersion,
      ledgerDigest: sha256Json(ledger),
      schemaDigest,
      databaseSha256: sha256File(file),
      sizeBytes: info.size,
    });
  } finally {
    database.close();
  }
}

function syncPath(file) {
  const descriptor = openSync(file, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeAtomic(file, content) {
  const partial = `${file}.partial-${process.pid}`;
  if (existsSync(file) || existsSync(partial)) fail();
  try {
    writeFileSync(partial, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    syncPath(partial);
    renameSync(partial, file);
    syncPath(path.dirname(file));
  } catch {
    rmSync(partial, { force: true });
    fail();
  }
}

function copyAtomic(source, destination, testFailureName) {
  const partial = `${destination}.partial-${process.pid}`;
  if (existsSync(destination) || existsSync(partial)) fail();
  try {
    copyFileSync(source, partial, constants.COPYFILE_EXCL);
    chmodSync(partial, 0o600);
    syncPath(partial);
    inspectDatabase(partial);
    if (
      process.env.LAITA_OPERATIONS_TESTING === "1" &&
      process.env[testFailureName] === "1"
    )
      throw new Error();
    renameSync(partial, destination);
    syncPath(path.dirname(destination));
  } catch {
    rmSync(partial, { force: true });
    fail();
  }
}

function metadata(kind, identity) {
  return {
    contractVersion: metadataContract,
    kind,
    schemaVersion: identity.schemaVersion,
    databaseSha256: identity.databaseSha256,
    ledgerDigest: identity.ledgerDigest,
    schemaDigest: identity.schemaDigest,
    sizeBytes: identity.sizeBytes,
  };
}

function readMetadata(file, kind) {
  validateFile(file);
  let value;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    fail();
  }
  if (
    !value ||
    Object.keys(value).sort().join(",") !==
      "contractVersion,databaseSha256,kind,ledgerDigest,schemaDigest,schemaVersion,sizeBytes" ||
    value.contractVersion !== metadataContract ||
    value.kind !== kind ||
    !Number.isSafeInteger(value.schemaVersion) ||
    !Number.isSafeInteger(value.sizeBytes)
  )
    fail();
  return value;
}

function verifyArtifact(file, metadataFile, kind) {
  const identity = inspectDatabase(file);
  const expected = readMetadata(metadataFile, kind);
  if (JSON.stringify(metadata(kind, identity)) !== JSON.stringify(expected))
    fail();
  return identity;
}

function createSnapshot() {
  validateAbsolute(databasePath);
  validateDirectory(backupDirectory);
  inspectDatabase(databasePath);
  assertQuiescent(databasePath);
  const snapshot = path.join(backupDirectory, snapshotName);
  const metadataFile = path.join(backupDirectory, snapshotMetadataName);
  copyAtomic(databasePath, snapshot, "LAITA_TEST_FAIL_SNAPSHOT_BEFORE_RENAME");
  const identity = inspectDatabase(snapshot);
  writeAtomic(
    metadataFile,
    `${JSON.stringify(metadata("PRE_MIGRATION", identity))}\n`,
  );
  verifyArtifact(snapshot, metadataFile, "PRE_MIGRATION");
  console.log(`SQLITE_SNAPSHOT_SCHEMA_VERSION=${identity.schemaVersion}`);
}

function verifySnapshot() {
  validateDirectory(backupDirectory);
  const identity = verifyArtifact(
    path.join(backupDirectory, snapshotName),
    path.join(backupDirectory, snapshotMetadataName),
    "PRE_MIGRATION",
  );
  console.log(`SQLITE_SNAPSHOT_SCHEMA_VERSION=${identity.schemaVersion}`);
}

function compatibilityCopy() {
  validateAbsolute(databasePath);
  validateAbsolute(backupDirectory);
  inspectDatabase(databasePath);
  copyAtomic(
    databasePath,
    backupDirectory,
    "LAITA_TEST_FAIL_COMPATIBILITY_COPY",
  );
}

function restoreSnapshot() {
  validateAbsolute(databasePath);
  validateDirectory(backupDirectory);
  inspectDatabase(databasePath);
  assertQuiescent(databasePath);
  const snapshot = path.join(backupDirectory, snapshotName);
  const snapshotMetadata = path.join(backupDirectory, snapshotMetadataName);
  verifyArtifact(snapshot, snapshotMetadata, "PRE_MIGRATION");

  const recovery = path.join(backupDirectory, recoveryName);
  const recoveryMetadata = path.join(backupDirectory, recoveryMetadataName);
  copyAtomic(databasePath, recovery, "LAITA_TEST_FAIL_RECOVERY_BEFORE_RENAME");
  const recoveryIdentity = inspectDatabase(recovery);
  writeAtomic(
    recoveryMetadata,
    `${JSON.stringify(metadata("FAILED_UPGRADE", recoveryIdentity))}\n`,
  );
  verifyArtifact(recovery, recoveryMetadata, "FAILED_UPGRADE");

  const restorePartial = `${databasePath}.restore-${process.pid}.partial`;
  if (existsSync(restorePartial)) fail();
  try {
    copyFileSync(snapshot, restorePartial, constants.COPYFILE_EXCL);
    chmodSync(restorePartial, 0o600);
    syncPath(restorePartial);
    const restoredIdentity = inspectDatabase(restorePartial);
    const snapshotIdentity = inspectDatabase(snapshot);
    if (JSON.stringify(restoredIdentity) !== JSON.stringify(snapshotIdentity))
      throw new Error();
    if (
      process.env.LAITA_OPERATIONS_TESTING === "1" &&
      process.env.LAITA_TEST_FAIL_RESTORE_BEFORE_RENAME === "1"
    )
      throw new Error();
    renameSync(restorePartial, databasePath);
    syncPath(path.dirname(databasePath));
  } catch {
    rmSync(restorePartial, { force: true });
    fail();
  }
  const restored = inspectDatabase(databasePath);
  const expected = inspectDatabase(snapshot);
  if (JSON.stringify(restored) !== JSON.stringify(expected)) fail();
  console.log(`SQLITE_RESTORED_SCHEMA_VERSION=${restored.schemaVersion}`);
  console.log(
    `SQLITE_RECOVERY_SCHEMA_VERSION=${recoveryIdentity.schemaVersion}`,
  );
}

try {
  if (command === "snapshot") createSnapshot();
  else if (command === "verify-snapshot") verifySnapshot();
  else if (command === "compatibility-copy") compatibilityCopy();
  else if (command === "restore") restoreSnapshot();
  else fail();
} catch {
  fail();
}
