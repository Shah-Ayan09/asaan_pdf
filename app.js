import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
import { PDFDocument } from 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const BUCKET = 'pdfs';
const PERSONAL_FOLDER = 'personal';

const $ = id => document.getElementById(id);
const statusEl = $('status');
let supabase;
let current = null;
let busy = false;

function setStatus(message) {
  if (statusEl) statusEl.textContent = message;
}

function show(id, visible) {
  const element = $(id);
  if (element) element.classList.toggle('hidden', !visible);
}

function requireSupabase() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error(
      'Supabase configuration is missing. Check VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in your .env file, then restart the dev server.'
    );
  }
  if (!supabase) supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  return supabase;
}

function safeError(error) {
  console.error(error);
  return error?.message || String(error) || 'Something went wrong.';
}

async function fileToBytes(file) {
  return new Uint8Array(await file.arrayBuffer());
}

/*
 * PDF-lib embeds JPEG and PNG, but the file picker accepts WebP and other
 * browser-supported formats too. Normalize selected images to PNG first.
 */
async function normalizeImage(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Your browser could not create an image canvas.');
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        result => result ? resolve(result) : reject(new Error(`Could not convert "${file.name}" to PNG.`)),
        'image/png'
      );
    });
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      contentType: 'image/png',
      previewUrl: URL.createObjectURL(blob),
      width: bitmap.width,
      height: bitmap.height
    };
  } catch (error) {
    throw new Error(
      `Could not read "${file.name}". Use JPG, PNG, or WebP. Some HEIC/HEIF images are not supported by this browser. ${error.message || ''}`
    );
  } finally {
    bitmap?.close?.();
  }
}

async function uploadFile(path, bytes, contentType) {
  const { error } = await requireSupabase().storage
    .from(BUCKET)
    .upload(path, bytes, { contentType, upsert: true });
  if (error) throw error;
}

async function getSignedUrl(path) {
  const { data, error } = await requireSupabase().storage
    .from(BUCKET)
    .createSignedUrl(path, 3600);
  if (error) throw error;
  if (!data?.signedUrl) throw new Error(`Could not create a link for ${path}.`);
  return data.signedUrl;
}

async function createPdfRecord(name) {
  const { data, error } = await requireSupabase()
    .from('pdfs')
    .insert({ name, storage_path: '' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function checkedFetch(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load a page file (HTTP ${response.status}). Check your Supabase Storage permissions and file path.`);
  }
  return response;
}

async function buildPdfBytes(pages) {
  if (!pages.length) throw new Error('This PDF has no pages yet. Add at least one image or PDF page first.');

  const output = await PDFDocument.create();

  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    if (!page.signedUrl) page.signedUrl = await getSignedUrl(page.storage_path);

    const response = await checkedFetch(page.signedUrl);
    const bytes = new Uint8Array(await response.arrayBuffer());

    if (page.source_type === 'image') {
      let image;
      try {
        image = await output.embedPng(bytes);
      } catch {
        try {
          image = await output.embedJpg(bytes);
        } catch {
          throw new Error(`Page ${index + 1} is not a supported PNG or JPEG image. Try adding that image again.`);
        }
      }

      const pageWidth = 595.28;
      const pageHeight = 841.89;
      const margin = 24;
      const dims = image.scale(1);
      const scale = Math.min(
        (pageWidth - margin * 2) / dims.width,
        (pageHeight - margin * 2) / dims.height
      );
      const width = dims.width * scale;
      const height = dims.height * scale;
      const pdfPage = output.addPage([pageWidth, pageHeight]);
      pdfPage.drawImage(image, {
        x: (pageWidth - width) / 2,
        y: (pageHeight - height) / 2,
        width,
        height
      });
    } else {
      const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const copied = await output.copyPages(source, source.getPageIndices());
      copied.forEach(copiedPage => output.addPage(copiedPage));
    }
  }

  return await output.save();
}

async function loadSavedPdfs() {
  const list = $('savedList');
  if (!list) return;
  list.innerHTML = '<p class="muted">Loading saved PDFs…</p>';

  try {
    const { data: pdfs, error } = await requireSupabase()
      .from('pdfs')
      .select('*')
      .order('updated_at', { ascending: false });

    if (error) throw error;
    list.innerHTML = '';

    if (!pdfs?.length) {
      list.innerHTML = '<p class="muted">No saved PDFs yet.</p>';
      return;
    }

    for (const pdf of pdfs) {
      const row = document.createElement('div');
      row.className = 'saved';

      const info = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = pdf.name || 'Untitled PDF';
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = pdf.updated_at
        ? `Updated ${new Date(pdf.updated_at).toLocaleString()}`
        : 'Saved PDF';
      info.append(title, meta);

      const openButton = document.createElement('button');
      openButton.textContent = 'Open';
      openButton.onclick = () => runSafely(() => openPdf(pdf));

      const downloadButton = document.createElement('button');
      downloadButton.textContent = 'Download';
      downloadButton.onclick = () => runSafely(() => downloadPdf(pdf));

      const deleteButton = document.createElement('button');
      deleteButton.className = 'danger';
      deleteButton.textContent = 'Delete';
      deleteButton.onclick = () => runSafely(() => deletePdf(pdf));

      row.append(info, openButton, downloadButton, deleteButton);
      list.appendChild(row);
    }
  } catch (error) {
    list.innerHTML = '';
    const message = document.createElement('p');
    message.className = 'muted';
    message.textContent = safeError(error);
    list.appendChild(message);
  }
}

async function runSafely(action) {
  if (busy) return;
  busy = true;
  try {
    await action();
  } catch (error) {
    setStatus(safeError(error));
  } finally {
    busy = false;
  }
}

async function openPdf(pdf) {
  setStatus('Opening PDF…');
  const { data: pages, error } = await requireSupabase()
    .from('pdf_pages')
    .select('*')
    .eq('pdf_id', pdf.id)
    .order('position', { ascending: true });

  if (error) throw error;

  for (const page of pages || []) {
    page.signedUrl = await getSignedUrl(page.storage_path);
  }

  current = { ...pdf, pages: pages || [] };
  $('docTitle').textContent = pdf.name || 'Untitled PDF';
  show('editorCard', true);
  await renderPages();
  setStatus(`Opened "${pdf.name}" with ${current.pages.length} page(s).`);
}

async function downloadPdf(pdf = current) {
  if (!pdf) throw new Error('Open or create a PDF first.');
  setStatus('Preparing PDF download…');

  let pages;
  if (current?.id === pdf.id && current.pages) {
    pages = current.pages;
  } else {
    const { data, error } = await requireSupabase()
      .from('pdf_pages')
      .select('*')
      .eq('pdf_id', pdf.id)
      .order('position', { ascending: true });
    if (error) throw error;
    pages = data || [];
  }

  for (const page of pages) {
    if (!page.signedUrl) page.signedUrl = await getSignedUrl(page.storage_path);
  }

  const bytes = await buildPdfBytes(pages);
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = (pdf.name || 'Asaan-PDF').toLowerCase().endsWith('.pdf')
    ? (pdf.name || 'Asaan-PDF')
    : `${pdf.name || 'Asaan-PDF'}.pdf`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  setStatus('PDF downloaded successfully.');
}

async function deletePdf(pdf) {
  if (!confirm(`Delete "${pdf.name}"? This cannot be undone.`)) return;

  const db = requireSupabase();
  const { data: pages, error: pageFetchError } = await db
    .from('pdf_pages')
    .select('storage_path')
    .eq('pdf_id', pdf.id);
  if (pageFetchError) throw pageFetchError;

  const paths = (pages || []).map(page => page.storage_path).filter(Boolean);
  if (paths.length) {
    const { error } = await db.storage.from(BUCKET).remove(paths);
    if (error) throw error;
  }

  const { error: deletePagesError } = await db.from('pdf_pages').delete().eq('pdf_id', pdf.id);
  if (deletePagesError) throw deletePagesError;

  const { error: deletePdfError } = await db.from('pdfs').delete().eq('id', pdf.id);
  if (deletePdfError) throw deletePdfError;

  if (current?.id === pdf.id) {
    current = null;
    show('editorCard', false);
  }
  await loadSavedPdfs();
  setStatus('PDF deleted.');
}

async function saveCurrent(showMessage = true) {
  if (!current) throw new Error('No PDF is open.');

  const db = requireSupabase();
  const rows = current.pages.map((page, index) => ({
    pdf_id: current.id,
    position: index,
    source_type: page.source_type,
    storage_path: page.storage_path
  }));

  setStatus('Saving page order…');

  const { error: deleteError } = await db
    .from('pdf_pages')
    .delete()
    .eq('pdf_id', current.id);
  if (deleteError) throw deleteError;

  if (rows.length) {
    const { error: insertError } = await db.from('pdf_pages').insert(rows);
    if (insertError) throw insertError;
  }

  const { error: updateError } = await db
    .from('pdfs')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', current.id);
  if (updateError) throw updateError;

  if (showMessage) setStatus('Saved.');
}

async function renderPages() {
  const container = $('pages');
  if (!container || !current) return;
  container.innerHTML = '';

  for (let i = 0; i < current.pages.length; i++) {
    const page = current.pages[i];
    const card = document.createElement('div');
    card.className = 'page';
    card.draggable = true;

    const canvas = document.createElement('canvas');
    card.appendChild(canvas);

    const label = document.createElement('div');
    label.className = 'label';
    const pageLabel = document.createElement('span');
    pageLabel.textContent = `Page ${i + 1}`;
    const typeLabel = document.createElement('span');
    typeLabel.textContent = page.source_type === 'image' ? 'Image' : 'PDF page';
    label.append(pageLabel, typeLabel);
    card.appendChild(label);

    const tools = document.createElement('div');
    tools.className = 'tools';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = 'Delete page';
    remove.onclick = () => runSafely(async () => {
      const [removed] = current.pages.splice(i, 1);
      await saveCurrent(false);
      if (removed?.localPreviewUrl) URL.revokeObjectURL(removed.localPreviewUrl);
      await renderPages();
      setStatus('Page deleted.');
    });
    tools.appendChild(remove);
    card.appendChild(tools);

    card.addEventListener('dragstart', event => {
      card.classList.add('dragging');
      event.dataTransfer.setData('text/plain', String(i));
      event.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('dragover', event => event.preventDefault());
    card.addEventListener('drop', event => {
      event.preventDefault();
      const from = Number(event.dataTransfer.getData('text/plain'));
      const to = i;
      if (!Number.isInteger(from) || from < 0 || from >= current.pages.length || from === to) return;
      const [moved] = current.pages.splice(from, 1);
      current.pages.splice(to, 0, moved);
      runSafely(async () => {
        await saveCurrent(false);
        await renderPages();
        setStatus('Pages rearranged.');
      });
    });

    container.appendChild(card);
    await renderThumbnail(page, canvas);
  }
}

async function renderThumbnail(page, canvas) {
  try {
    const url = page.localPreviewUrl || page.signedUrl || await getSignedUrl(page.storage_path);
    page.signedUrl ||= url;
    const response = await checkedFetch(url);

    if (page.source_type === 'image') {
      const bitmap = await createImageBitmap(await response.blob());
      canvas.width = 240;
      canvas.height = Math.max(1, Math.round(240 * bitmap.height / bitmap.width));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close?.();
      return;
    }

    const bytes = await response.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const pdfPage = await pdf.getPage(1);
    const base = pdfPage.getViewport({ scale: 1 });
    const viewport = pdfPage.getViewport({ scale: 240 / base.width });
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  } catch (error) {
    console.error('Thumbnail failed:', error);
    canvas.width = 240;
    canvas.height = 120;
    const context = canvas.getContext('2d');
    context.fillStyle = '#333';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#fff';
    context.font = '13px sans-serif';
    context.fillText('Preview unavailable', 38, 65);
  }
}

async function addImageFiles(fileList) {
  if (!current) throw new Error('Create a PDF first.');
  const files = [...(fileList || [])].filter(file =>
    file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(file.name)
  );
  if (!files.length) {
    setStatus('Please choose one or more image files.');
    return;
  }

  setStatus(`Adding ${files.length} image(s)…`);
  const added = [];

  for (const file of files) {
    const normalized = await normalizeImage(file);
    const path = `${PERSONAL_FOLDER}/${current.id}/image-${crypto.randomUUID()}.png`;

    try {
      await uploadFile(path, normalized.bytes, normalized.contentType);
      added.push({
        pdf_id: current.id,
        source_type: 'image',
        storage_path: path,
        signedUrl: normalized.previewUrl,
        localPreviewUrl: normalized.previewUrl
      });
    } catch (error) {
      URL.revokeObjectURL(normalized.previewUrl);
      throw new Error(`Image "${file.name}" was read but could not be saved to Supabase Storage: ${error.message}`);
    }
  }

  current.pages.push(...added);
  try {
    await saveCurrent(false);
  } catch (error) {
    current.pages.splice(current.pages.length - added.length, added.length);
    for (const page of added) URL.revokeObjectURL(page.localPreviewUrl);
    throw error;
  }

  await renderPages();
  await loadSavedPdfs();
  setStatus(`Added ${added.length} image page(s). You can now rearrange, save, or download the PDF.`);
}

async function importPdfFile(file) {
  if (!file) return;
  setStatus('Importing PDF and splitting it into pages…');

  const sourceBytes = await fileToBytes(file);
  const sourcePdf = await PDFDocument.load(sourceBytes, { ignoreEncryption: true });
  const pageIndices = sourcePdf.getPageIndices();
  if (!pageIndices.length) throw new Error('The selected PDF contains no pages.');

  const pdf = await createPdfRecord(file.name);
  current = { ...pdf, pages: [] };
  show('editorCard', true);
  $('docTitle').textContent = pdf.name || file.name;

  for (let i = 0; i < pageIndices.length; i++) {
    setStatus(`Importing PDF page ${i + 1} of ${pageIndices.length}…`);
    const onePagePdf = await PDFDocument.create();
    const [copiedPage] = await onePagePdf.copyPages(sourcePdf, [i]);
    onePagePdf.addPage(copiedPage);
    const pageBytes = await onePagePdf.save();
    const path = `${PERSONAL_FOLDER}/${pdf.id}/page-${i + 1}.pdf`;
    await uploadFile(path, pageBytes, 'application/pdf');
    current.pages.push({
      pdf_id: pdf.id,
      source_type: 'pdf',
      storage_path: path
    });
  }

  await saveCurrent(false);
  await renderPages();
  await loadSavedPdfs();
  setStatus(`Imported "${file.name}" as ${pageIndices.length} page(s).`);
}

/* Wire up the HTML supplied with this app. */
$('newPdf').addEventListener('click', () => $('imageInput').click());
$('addImages').addEventListener('click', () => $('imageInput').click());
$('uploadPdf').addEventListener('click', () => $('pdfInput').click());

$('imageInput').addEventListener('change', event => {
  const files = [...event.target.files];
  event.target.value = '';
  if (!files.length) return;

  runSafely(async () => {
    if (!current) {
      const name = prompt('Name this PDF:', `PDF ${new Date().toLocaleString()}`);
      if (!name?.trim()) {
        setStatus('PDF creation cancelled.');
        return;
      }
      const pdf = await createPdfRecord(name.trim());
      current = { ...pdf, pages: [] };
      $('docTitle').textContent = current.name || 'Untitled PDF';
      show('editorCard', true);
    }
    await addImageFiles(files);
  });
});

$('pdfInput').addEventListener('change', event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (file) runSafely(() => importPdfFile(file));
});

const drop = $('drop');
drop.addEventListener('dragenter', event => {
  event.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragover', event => {
  event.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', event => {
  event.preventDefault();
  drop.classList.remove('over');
  const files = [...(event.dataTransfer?.files || [])];
  if (!files.length) return;
  runSafely(async () => {
    if (!current) {
      const name = prompt('Name this PDF:', `PDF ${new Date().toLocaleString()}`);
      if (!name?.trim()) return;
      const pdf = await createPdfRecord(name.trim());
      current = { ...pdf, pages: [] };
      $('docTitle').textContent = current.name || 'Untitled PDF';
      show('editorCard', true);
    }
    await addImageFiles(files);
  });
});
drop.addEventListener('click', () => $('imageInput').click());

$('savePdf').addEventListener('click', () => runSafely(() => saveCurrent()));
$('downloadPdf').addEventListener('click', () => runSafely(() => downloadPdf(current)));
$('closeEditor').addEventListener('click', () => {
  if (current?.pages) {
    for (const page of current.pages) {
      if (page.localPreviewUrl) URL.revokeObjectURL(page.localPreviewUrl);
    }
  }
  current = null;
  show('editorCard', false);
  setStatus('');
  loadSavedPdfs();
});

setStatus('Starting Asaan PDF…');
loadSavedPdfs();
