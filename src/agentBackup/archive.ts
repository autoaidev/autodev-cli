import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';

/**
 * Abstraction over a zip archive used by the agent backup feature.
 *
 * Export and import depend on this interface rather than on `adm-zip`
 * directly (Dependency Inversion). All path arguments that point at the
 * filesystem are absolute; all `archivePath` arguments are POSIX-style
 * paths *inside* the archive.
 */
export interface Archive {
  // --- write side ---------------------------------------------------------
  /** Add a single file. No-op if the source is missing or not a file. */
  addFile(absSource: string, archivePath: string): void;
  /** Add a directory tree. No-op if the source is missing or not a dir. */
  addDir(absSourceDir: string, archiveDir: string): void;
  /** Add raw bytes at the given archive path. */
  addBuffer(archivePath: string, data: Buffer): void;
  /** Persist the archive to disk. */
  write(destPath: string): void;

  // --- read side ----------------------------------------------------------
  /** All entry paths in the archive (POSIX-style, dirs end with `/`). */
  entryPaths(): string[];
  /** Read a text entry, or `undefined` if it does not exist. */
  readText(archivePath: string): string | undefined;
  /**
   * Extract every entry whose path starts with `archiveDirPrefix` into
   * `destAbsDir`, preserving the structure *below* the prefix.
   * Returns the number of files written.
   */
  extractDir(archiveDirPrefix: string, destAbsDir: string): number;
}

/** Normalise to forward slashes (adm-zip stores POSIX separators). */
function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** `adm-zip`-backed {@link Archive} implementation. */
export class AdmZipArchive implements Archive {
  private readonly zip: AdmZip;

  private constructor(zip: AdmZip) {
    this.zip = zip;
  }

  /** Create an empty archive for writing. */
  static create(): AdmZipArchive {
    return new AdmZipArchive(new AdmZip());
  }

  /** Open an existing archive on disk for reading. */
  static open(zipPath: string): AdmZipArchive {
    return new AdmZipArchive(new AdmZip(zipPath));
  }

  addFile(absSource: string, archivePath: string): void {
    if (!fs.existsSync(absSource)) { return; }
    try {
      if (!fs.statSync(absSource).isFile()) { return; }
      const ap = toPosix(archivePath);
      this.zip.addLocalFile(absSource, path.posix.dirname(ap), path.posix.basename(ap));
    } catch { /* ignore unreadable file */ }
  }

  addDir(absSourceDir: string, archiveDir: string): void {
    if (!fs.existsSync(absSourceDir)) { return; }
    try {
      if (!fs.statSync(absSourceDir).isDirectory()) { return; }
      this.zip.addLocalFolder(absSourceDir, toPosix(archiveDir));
    } catch { /* ignore unreadable dir */ }
  }

  addBuffer(archivePath: string, data: Buffer): void {
    this.zip.addFile(toPosix(archivePath), data);
  }

  write(destPath: string): void {
    this.zip.writeZip(destPath);
  }

  entryPaths(): string[] {
    return this.zip.getEntries().map(e => toPosix(e.entryName));
  }

  readText(archivePath: string): string | undefined {
    const entry = this.zip.getEntry(toPosix(archivePath));
    if (!entry || entry.isDirectory) { return undefined; }
    try { return entry.getData().toString('utf8'); } catch { return undefined; }
  }

  extractDir(archiveDirPrefix: string, destAbsDir: string): number {
    const prefix = toPosix(archiveDirPrefix).replace(/\/$/, '') + '/';
    let written = 0;
    for (const entry of this.zip.getEntries()) {
      const name = toPosix(entry.entryName);
      if (entry.isDirectory || !name.startsWith(prefix)) { continue; }
      const rel = name.slice(prefix.length);
      if (!rel || rel.includes('..')) { continue; } // guard against zip-slip
      const dest = path.join(destAbsDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      try {
        fs.writeFileSync(dest, entry.getData());
        written++;
      } catch { /* ignore unwritable target */ }
    }
    return written;
  }
}
