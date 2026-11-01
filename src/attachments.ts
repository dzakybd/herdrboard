import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 20;

export interface Upload {
  name: string;
  data: string; // base64
}

export interface Attachment {
  name: string;
  size: number;
}

export const attachmentDir = (home: string, cardId: number): string => `${home}/cards/${cardId}/attachments`;

/** A name that is safe in a path, a shell and a prompt: no folders, no spaces, no leading dot. */
export function safeName(raw: string): string {
  const base = String(raw).split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 100);
  return clean || "file";
}

function unusedName(dir: string, name: string): string {
  if (!existsSync(`${dir}/${name}`)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 2; ; n++) if (!existsSync(`${dir}/${stem}-${n}${ext}`)) return `${stem}-${n}${ext}`;
}

export function listAttachments(home: string, cardId: number): Attachment[] {
  const dir = attachmentDir(home, cardId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => ({ name, size: statSync(`${dir}/${name}`).size }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Writes the uploads under the card's folder and returns the files' absolute paths. Throws before writing anything if one is invalid. */
export function saveAttachments(home: string, cardId: number, uploads: unknown): string[] {
  if (uploads === undefined || uploads === null) return [];
  if (!Array.isArray(uploads)) throw new Error("attachments must be a list of {name, data}");
  if (!uploads.length) return [];
  if (listAttachments(home, cardId).length + uploads.length > MAX_FILES) throw new Error(`at most ${MAX_FILES} attachments per card`);
  const files = uploads.map((u: Upload) => {
    if (typeof u?.name !== "string" || typeof u?.data !== "string") throw new Error("each attachment needs a name and base64 data");
    const bytes = Buffer.from(u.data, "base64");
    if (bytes.length > MAX_FILE_BYTES) throw new Error(`${u.name} is over ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    return { name: safeName(u.name), bytes };
  });
  const dir = attachmentDir(home, cardId);
  mkdirSync(dir, { recursive: true });
  return files.map(({ name, bytes }) => {
    const final = unusedName(dir, name);
    writeFileSync(`${dir}/${final}`, bytes);
    return `${dir}/${final}`;
  });
}

/** Absolute path of one attachment, or null. The name must match a listed file, so no path can escape the folder. */
export function attachmentPath(home: string, cardId: number, name: string): string | null {
  return listAttachments(home, cardId).some((a) => a.name === name) ? `${attachmentDir(home, cardId)}/${name}` : null;
}

export function removeAttachments(home: string, cardId: number): void {
  rmSync(`${home}/cards/${cardId}`, { recursive: true, force: true });
}
