import "dotenv/config";
import fs from "fs";
import path from "path";

const API = "https://api.openai.com/v1";
const BETA = "assistants=v2";
const CACHE_PATH = ".vectorstore.json";
const MAX_PDFS = 10;

// ---------- CLI args ----------
const argv = process.argv.slice(2);
const prompt = argv[0] || "Ask something about the PDFs.";
const pdfDir = argv[1] || "./pdfs";

const flags = new Map();
for (let i = 2; i < argv.length; i += 2) {
  if (argv[i]?.startsWith("--")) flags.set(argv[i], argv[i + 1] ?? true);
}
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const REUSE_VS_FLAG = flags.get("--reuse");                
const REUSE_VS_ENV  = process.env.VECTOR_STORE_ID || null; 

if (!process.env.OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in .env");
  process.exit(1);
}

// ---------- HTTP helpers ----------
function headersJSON() {
  return {
    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": BETA,
  };
}
function headersNoJSON() {
  return {
    "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    "OpenAI-Beta": BETA,
  };
}
async function api(pathname, { method = "GET", headers = {}, body } = {}) {
  const res = await fetch(`${API}${pathname}`, { method, headers, body });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} @ ${pathname}\n${txt}`);
  }
  return res.json();
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- Cache helpers ----------
function readCachedVS() {
  if (!fs.existsSync(CACHE_PATH)) return null;
  try {
    const cached = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    return cached?.vectorStoreId || null;
  } catch { return null; }
}
function writeCachedVS(id) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify({ vectorStoreId: id }, null, 2));
}

// ---------- Vector store existence check ----------
async function vectorStoreExists(id) {
  try {
    await api(`/vector_stores/${id}`, { headers: headersNoJSON() });
    return true;
  } catch (e) {
    if (String(e.message).includes("HTTP 404")) return false;
    throw e; 
  }
}

// ---------- Upload one PDF to /files (multipart) ----------
async function uploadFile(filePath) {
  const form = new FormData();
  const buf = await fs.promises.readFile(filePath);
  const blob = new Blob([buf], { type: "application/pdf" });
  form.append("file", blob, path.basename(filePath));
  form.append("purpose", "assistants"); 

  const res = await fetch(`${API}/files`, {
    method: "POST",
    headers: headersNoJSON(), 
    body: form,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} @ /files\n${await res.text()}`);
  return res.json(); 
}

// ---------- Batch polling ----------
async function pollBatch(vectorStoreId, batchId) {
  let status = "in_progress";
  while (status === "in_progress" || status === "queued") {
    await sleep(1400);
    const cur = await api(`/vector_stores/${vectorStoreId}/file_batches/${batchId}`, {
      headers: headersNoJSON(),
    });
    status = cur.status;
  }
  if (status !== "completed") throw new Error(`File batch failed with status: ${status}`);
}

// ---------- Helpers to list VS files & sync new PDFs ----------
async function listVectorStoreFiles(vectorStoreId) {
  const namesToIds = new Map();
  let url = `/vector_stores/${vectorStoreId}/files?limit=100`;
  while (url) {
    const page = await api(url.replace(API, ""), { headers: headersNoJSON() });
    for (const item of page.data || []) {
      const candidateIds = [item.file_id, item.id].filter(Boolean);
      for (const fid of candidateIds) {
        try {
          const f = await api(`/files/${fid}`, { headers: headersNoJSON() });
          if (f?.filename) namesToIds.set(f.filename, f.id);
          break;
        } catch {
          // catch bugs
        }
      }
    }
    url = page?.has_more && page?.last_id
      ? `${API}/vector_stores/${vectorStoreId}/files?limit=100&after=${page.last_id}`
      : null;
  }
  return namesToIds;
}

/** Uploads ONLY new PDFs from pdfDir and attaches them to the existing VS */
async function syncNewPdfsIntoVectorStore(vectorStoreId, pdfDir) {
  const localPdfs = fs.readdirSync(pdfDir)
    .filter(f => f.toLowerCase().endsWith(".pdf"))
    .slice(0, MAX_PDFS)
    .map(name => ({ name, full: path.join(pdfDir, name) }));

  if (!localPdfs.length) return { attached: 0 };

  // Remote filenames already in VS
  const remoteMap = await listVectorStoreFiles(vectorStoreId); // Map<filename, file_id>

  // Determine which local PDFs are NEW by filename
  const newOnes = localPdfs.filter(p => !remoteMap.has(p.name));
  if (!newOnes.length) return { attached: 0 };

  console.log(`Found ${newOnes.length} new PDF(s): ${newOnes.map(n => n.name).join(", ")}`);

  // Upload new files -> file_ids
  const newFileIds = [];
  for (const p of newOnes) {
    const f = await uploadFile(p.full);
    newFileIds.push(f.id);
  }

  // Attach to vector store via file_batch + poll
  const batch = await api(`/vector_stores/${vectorStoreId}/file_batches`, {
    method: "POST",
    headers: headersJSON(),
    body: JSON.stringify({ file_ids: newFileIds }),
  });
  await pollBatch(vectorStoreId, batch.id);

  console.log(`Synced ${newOnes.length} new PDF(s) into ${vectorStoreId}`);
  return { attached: newOnes.length };
}

// ---------- Create & index a new vector store from local PDFs ----------
async function createAndIndexVectorStore(pdfDir) {
  const pdfPaths = fs.readdirSync(pdfDir)
    .filter(f => f.toLowerCase().endsWith(".pdf"))
    .slice(0, MAX_PDFS)
    .map(f => path.join(pdfDir, f));

  if (!pdfPaths.length) {
    throw new Error(`No PDFs found in "${pdfDir}". Put up to ${MAX_PDFS} PDFs there.`);
  }
  console.log(`Indexing ${pdfPaths.length} PDF(s) from ${pdfDir} ...`);

  // 1) Create vector store
  const vs = await api("/vector_stores", {
    method: "POST",
    headers: headersJSON(),
    body: JSON.stringify({ name: `pdf-search-${Date.now()}` }),
  });

  // 2) Upload PDFs -> file_ids
  const fileIds = [];
  for (const p of pdfPaths) {
    const f = await uploadFile(p);
    fileIds.push(f.id);
  }

  // 3) Attach via file batch (JSON)
  const batch = await api(`/vector_stores/${vs.id}/file_batches`, {
    method: "POST",
    headers: headersJSON(),
    body: JSON.stringify({ file_ids: fileIds }),
  });
  await pollBatch(vs.id, batch.id);

  // Cache and return
  writeCachedVS(vs.id);
  console.log(`Vector store created & cached: ${vs.id}`);
  return vs.id;
}

// ---------- Reuse if exists; else create; and always sync new PDFs ----------
async function getOrCreateVectorStoreAndSync(pdfDir) {
  const candidate = REUSE_VS_FLAG || REUSE_VS_ENV || readCachedVS();

  if (candidate) {
    const ok = await vectorStoreExists(candidate);
    if (ok) {
      // sync any new local PDFs into this existing store
      await syncNewPdfsIntoVectorStore(candidate, pdfDir);
      return candidate;
    }
    console.warn(`Vector store ${candidate} not found. Creating a new one...`);
  }

  return createAndIndexVectorStore(pdfDir);
}

// ---------- Q&A pipeline ----------
async function askQuestion(prompt, pdfDir) {
  const vectorStoreId = await getOrCreateVectorStoreAndSync(pdfDir);

  // Assistant wired to your vector store
  const assistant = await api("/assistants", {
    method: "POST",
    headers: headersJSON(),
    body: JSON.stringify({
      name: "PDF Search Assistant",
      model: MODEL,
      tools: [{ type: "file_search" }],
      tool_resources: { file_search: { vector_store_ids: [vectorStoreId] } },
    }),
  });

  // Thread with the user's message
  const thread = await api("/threads", {
    method: "POST",
    headers: headersJSON(),
    body: JSON.stringify({ messages: [{ role: "user", content: prompt }] }),
  });

  // Run & poll
  let run = await api(`/threads/${thread.id}/runs`, {
    method: "POST",
    headers: headersJSON(),
    body: JSON.stringify({ assistant_id: assistant.id }),
  });
  while (["queued", "in_progress", "cancelling"].includes(run.status)) {
    await sleep(1400);
    run = await api(`/threads/${thread.id}/runs/${run.id}`, { headers: headersNoJSON() });
  }
  if (run.status !== "completed") {
    console.error("Run failed. Details:", JSON.stringify({
      status: run.status,
      last_error: run.last_error,
      required_action: run.required_action,
    }, null, 2));
    throw new Error(`Run ended with status: ${run.status}${run?.last_error?.message ? ` — ${run.last_error.message}` : ""}`);
  }

  // Fetch latest assistant text
  const msgs = await api(`/threads/${thread.id}/messages?order=desc&limit=5`, {
    headers: headersNoJSON(),
  });
  const firstAssistant = msgs?.data?.find(m => m.role === "assistant");
  const text = firstAssistant?.content?.map(c => c?.text?.value).filter(Boolean).join("\n")?.trim();

  console.log("\n=== Answer ===\n");
  console.log(text || "(no text)");

  console.log(`\nVector Store ID: ${vectorStoreId} (pass with --reuse or set VECTOR_STORE_ID in .env)`);
}

// ---------- Run ----------
askQuestion(prompt, pdfDir).catch(err => {
  console.error("\nError:", err.message || err);
  process.exit(1);
});
