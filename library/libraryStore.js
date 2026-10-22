// Per-user media library: images, videos and files (PDFs) created or uploaded in the app.
// Metadata lives in data/library.json (outside public/); the files themselves live under uploads/.
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

const LIBRARY_FILE = path.join(process.cwd(), "data", "library.json");
const LIBRARY_UPLOAD_DIR = path.join(process.cwd(), "uploads", "library");

const EXTENSIONS = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "application/pdf": ".pdf",
};

export function libraryTypeFor(mime) {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

export function isLibraryMime(mime) {
  return Boolean(EXTENSIONS[mime]);
}

async function readLibrary() {
  try {
    const items = JSON.parse(await fs.promises.readFile(LIBRARY_FILE, "utf8"));
    return Array.isArray(items) ? items : [];
  } catch (err) {
    return [];
  }
}

// Serialize read-modify-write cycles so concurrent requests don't overwrite each other
let queue = Promise.resolve();

function updateLibrary(mutate) {
  const run = queue.then(async () => {
    await fs.promises.mkdir(path.dirname(LIBRARY_FILE), { recursive: true });
    const items = await readLibrary();
    const result = mutate(items);
    await fs.promises.writeFile(LIBRARY_FILE, JSON.stringify(items, null, 2), "utf8");
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

// Records a file that already exists under uploads/ (created images, finished videos)
export function addLibraryItem({ owner, type, name, url, mime, size = 0, source }) {
  const item = {
    id: randomUUID(),
    owner,
    type,
    name,
    url,
    mime,
    size,
    source,
    createdAt: new Date().toISOString(),
  };
  return updateLibrary((items) => {
    items.push(item);
    return item;
  });
}

// Saves an in-memory upload (multer memoryStorage file) to disk and records it
export async function saveUploadToLibrary(owner, file, source) {
  const ext = EXTENSIONS[file.mimetype] || path.extname(file.originalname) || "";
  const storedName = `${randomUUID()}${ext}`;
  await fs.promises.mkdir(LIBRARY_UPLOAD_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(LIBRARY_UPLOAD_DIR, storedName), file.buffer);

  return addLibraryItem({
    owner,
    type: libraryTypeFor(file.mimetype),
    name: file.originalname || storedName,
    url: `/uploads/library/${storedName}`,
    mime: file.mimetype,
    size: file.size,
    source,
  });
}

export async function listLibrary(owner, type) {
  const items = await readLibrary();
  return items
    .filter((item) => item.owner === owner && (!type || type === "all" || item.type === type))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(({ owner: _owner, ...item }) => item);
}

// Removes the record and its file. Only files inside uploads/ are ever deleted.
export async function deleteLibraryItem(owner, id) {
  const removed = await updateLibrary((items) => {
    const index = items.findIndex((item) => item.id === id && item.owner === owner);
    if (index === -1) return null;
    return items.splice(index, 1)[0];
  });
  if (!removed) return false;

  const uploadsRoot = path.join(process.cwd(), "uploads");
  const filePath = path.resolve(process.cwd(), `.${removed.url}`);
  if (filePath.startsWith(uploadsRoot + path.sep)) {
    await fs.promises.rm(filePath, { force: true });
    // A video lives in its own folder (uploads/videos/<job>/video.mp4); remove the empty folder too
    if (removed.type === "video" && path.basename(filePath) === "video.mp4") {
      await fs.promises.rm(path.dirname(filePath), { recursive: true, force: true });
    }
  }
  return true;
}
