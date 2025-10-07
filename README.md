# 🧠 OpenAI RAG (PDF Search Assistant)

A minimal **Retrieval-Augmented Generation (RAG)** setup using **OpenAI Assistants API v2**.  
It indexes and searches the contents of **PDF files** directly via OpenAI’s vector stores — no need for Pinecone, FAISS, or Chroma.

---

## 🚀 Features

- Upload and index up to **10 PDFs** automatically  
- Persistent local cache of vector store (`.vectorstore.json`)  
- **Syncs new PDFs** automatically into the existing store  
- **Reuse vector store** across sessions (`--reuse` flag or `.env`)  
- Runs both as a **CLI script** and a **Next.js API route**  
- Uses `gpt-4.1-mini` (default) or any supported model  

---

## 🧩 Requirements

- Node.js **v18+**
- An **OpenAI API key** with access to `assistants=v2`
- Basic familiarity with terminal or Next.js API routes

---

## ⚙️ Setup

1. **Clone the project**
   ```bash
   git clone https://github.com/your-username/openai-pdf-rag.git
   cd openai-pdf-rag
2. **Install dependencies**
  ```bash
  npm install
  ```
3. **env file content**
  ```
  OPENAI_API_KEY=your-key
  VECTOR_STORE_ID=your-vector-id
  ```
4. **Execute**
   ```
   npm install
   ```

