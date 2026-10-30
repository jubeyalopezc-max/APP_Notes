package com.notespro.app;

import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Cuando otra app (WhatsApp, Drive, Archivos…) abre o comparte un PDF con NotesPro,
 * se copia a la caché de la app y se avisa a la parte web con la ruta del archivo.
 */
@CapacitorPlugin(name = "SharedFile")
public class SharedFilePlugin extends Plugin {
    private JSObject pending = null;

    @Override
    public void load() {
        handle(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handle(intent);
    }

    /** Devuelve (y olvida) el último archivo recibido, por si llegó antes de que la app estuviera lista. */
    @PluginMethod
    public void getPending(PluginCall call) {
        JSObject ret = new JSObject();
        if (pending != null) {
            ret.put("file", pending);
            pending = null;
        }
        call.resolve(ret);
    }

    @SuppressWarnings("deprecation")
    private void handle(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        Uri uri = null;
        if (Intent.ACTION_VIEW.equals(action)) {
            uri = intent.getData();
        } else if (Intent.ACTION_SEND.equals(action)) {
            if (Build.VERSION.SDK_INT >= 33) uri = intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
            else uri = (Uri) intent.getParcelableExtra(Intent.EXTRA_STREAM);
        }
        if (uri == null) return;
        final Uri src = uri;
        final String type = intent.getType();
        // Que el mismo archivo no se vuelva a importar si la app se recrea.
        getActivity().setIntent(new Intent(Intent.ACTION_MAIN));
        new Thread(() -> {
            try {
                String name = displayName(src);
                File dir = new File(getContext().getCacheDir(), "compartidos");
                if (!dir.exists()) dir.mkdirs();
                File out = new File(dir, System.currentTimeMillis() + "-" + name.replaceAll("[^\\w.\\- ]", "_"));
                InputStream in = getContext().getContentResolver().openInputStream(src);
                if (in == null) throw new Exception("No se pudo leer el archivo");
                try (InputStream input = in; OutputStream os = new FileOutputStream(out)) {
                    byte[] buf = new byte[65536];
                    int n;
                    while ((n = input.read(buf)) > 0) os.write(buf, 0, n);
                }
                JSObject data = new JSObject();
                data.put("path", out.getAbsolutePath());
                data.put("name", name);
                data.put("type", type == null ? "" : type);
                pending = data;
                notifyListeners("file", data, true);
            } catch (Exception e) {
                JSObject err = new JSObject();
                err.put("error", e.getMessage() == null ? "error" : e.getMessage());
                notifyListeners("fileError", err, true);
            }
        }).start();
    }

    private String displayName(Uri uri) {
        String name = null;
        try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) name = c.getString(0);
        } catch (Exception ignored) {
        }
        if (name == null) name = uri.getLastPathSegment();
        if (name == null || name.isEmpty()) name = "documento.pdf";
        return name;
    }
}
