// Guardar y compartir archivos. En la tablet usa los complementos de Capacitor;
// en un navegador normal descarga el archivo.

const Cap = window.Capacitor;
export const isNative = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
const FS = isNative ? Cap.Plugins.Filesystem : null;
const Share = isNative ? Cap.Plugins.Share : null;

export const DEVICE_FOLDER = 'Documentos/NotesPro';

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function writeDocuments(path, data) {
  const opts = { path: `NotesPro/${path}`, data, directory: 'DOCUMENTS', recursive: true };
  try {
    await FS.writeFile(opts);
  } catch (e) {
    // Android 10 o anterior: pedir permiso y reintentar una vez.
    try { await FS.requestPermissions(); } catch {}
    await FS.writeFile(opts);
  }
  return `${DEVICE_FOLDER}/${path}`;
}

/** Guarda una copia en la tablet (Documentos/NotesPro). Devuelve la ruta o null. */
export async function saveToDevice(blob, path) {
  if (!isNative) return null;
  try { return await writeDocuments(path, await blobToBase64(blob)); }
  catch { return null; }
}

/** Abre el menú de Android para enviar el archivo (Drive, WhatsApp, correo…). En navegador, lo descarga. */
export async function shareFile(blob, filename) {
  if (!isNative) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return 'downloaded';
  }
  const { uri } = await FS.writeFile({ path: filename, data: await blobToBase64(blob), directory: 'CACHE' });
  try {
    await Share.share({ title: filename, files: [uri], dialogTitle: 'Enviar o guardar el archivo' });
    return 'shared';
  } catch {
    return 'cancelled'; // la persona cerró el menú
  }
}
