package com.notespro.app;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Actualizaciones de NotesPro: descarga el APK nuevo publicado en GitHub y abre el instalador
 * de Android. Android siempre pide confirmar con "Instalar" (eso no se puede saltar sin Play Store).
 */
@CapacitorPlugin(name = "Updater")
public class UpdaterPlugin extends Plugin {
    private volatile boolean downloading = false;

    /** Versión instalada y si ya se dio permiso para instalar actualizaciones. */
    @PluginMethod
    public void info(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            Context ctx = getContext();
            PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
            long code = Build.VERSION.SDK_INT >= 28 ? pi.getLongVersionCode() : pi.versionCode;
            ret.put("versionCode", code);
            ret.put("versionName", pi.versionName);
        } catch (PackageManager.NameNotFoundException e) {
            ret.put("versionCode", 0);
            ret.put("versionName", "");
        }
        ret.put("canInstall", canInstall());
        call.resolve(ret);
    }

    private boolean canInstall() {
        if (Build.VERSION.SDK_INT < 26) return true;
        return getContext().getPackageManager().canRequestPackageInstalls();
    }

    /** Abre el ajuste "Instalar apps desconocidas" de NotesPro. */
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        try {
            Intent i;
            if (Build.VERSION.SDK_INT >= 26) {
                i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            } else {
                i = new Intent(Settings.ACTION_SECURITY_SETTINGS);
            }
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("No se pudieron abrir los ajustes.");
        }
    }

    /** Descarga el APK (sigue las redirecciones de GitHub) y avisa el progreso con el evento "progress". */
    @PluginMethod
    public void download(PluginCall call) {
        final String url = call.getString("url");
        if (url == null || !url.startsWith("https://")) { call.reject("Dirección no válida."); return; }
        if (downloading) { call.reject("Ya se está descargando la actualización."); return; }
        downloading = true;
        new Thread(() -> {
            File dir = new File(getContext().getCacheDir(), "updates");
            File out = new File(dir, "NotesPro-update.apk");
            HttpURLConnection con = null;
            try {
                if (!dir.exists()) dir.mkdirs();
                if (out.exists()) out.delete();
                String current = url;
                for (int hops = 0; ; hops++) {
                    con = (HttpURLConnection) new URL(current).openConnection();
                    con.setInstanceFollowRedirects(false);
                    con.setConnectTimeout(20000);
                    con.setReadTimeout(30000);
                    con.setRequestProperty("Accept", "application/octet-stream");
                    int code = con.getResponseCode();
                    if (code >= 300 && code < 400 && hops < 6) {
                        String loc = con.getHeaderField("Location");
                        con.disconnect();
                        if (loc == null) throw new Exception("Redirección sin destino");
                        current = new URL(new URL(current), loc).toString();
                        if (!current.startsWith("https://")) throw new Exception("Redirección insegura");
                        continue;
                    }
                    if (code != 200) throw new Exception("HTTP " + code);
                    break;
                }
                long total = con.getContentLengthLong();
                long done = 0, lastSent = 0;
                try (InputStream in = con.getInputStream(); OutputStream os = new FileOutputStream(out)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        os.write(buf, 0, n);
                        done += n;
                        long now = System.currentTimeMillis();
                        if (now - lastSent > 250) {
                            lastSent = now;
                            JSObject p = new JSObject();
                            p.put("done", done);
                            p.put("total", total);
                            notifyListeners("progress", p);
                        }
                    }
                }
                if (total > 0 && done != total) throw new Exception("Descarga incompleta");
                JSObject ret = new JSObject();
                ret.put("path", out.getAbsolutePath());
                ret.put("size", done);
                call.resolve(ret);
            } catch (Exception e) {
                if (out.exists()) out.delete();
                call.reject("No se pudo descargar la actualización. Revisa tu conexión a internet.", e);
            } finally {
                if (con != null) con.disconnect();
                downloading = false;
            }
        }).start();
    }

    /** Abre el instalador de Android con el APK descargado. */
    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        File f = path == null ? null : new File(path);
        File dir = new File(getContext().getCacheDir(), "updates");
        if (f == null || !f.exists() || !dir.equals(f.getParentFile())) { call.reject("No se encontró la actualización descargada."); return; }
        if (!canInstall()) { call.reject("Falta el permiso para instalar actualizaciones."); return; }
        try {
            Context ctx = getContext();
            Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", f);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
            call.resolve();
        } catch (Exception e) {
            call.reject("No se pudo abrir el instalador.", e);
        }
    }

    /** Borra APK descargados que ya no hacen falta. */
    @PluginMethod
    public void cleanup(PluginCall call) {
        File dir = new File(getContext().getCacheDir(), "updates");
        File[] files = dir.listFiles();
        if (files != null) for (File f : files) f.delete();
        call.resolve();
    }
}
