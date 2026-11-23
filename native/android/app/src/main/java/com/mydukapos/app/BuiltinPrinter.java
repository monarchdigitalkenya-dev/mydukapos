package com.mydukapos.app;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import recieptservice.com.recieptservice.PrinterInterface;

/**
 * Adapter for the thermal printer built into Senraise-made Android handheld terminals (the H10 / H10S family and relatives).
 *
 * HOW IT WORKS (evidence in docs/BUILTIN_PRINTER_336.md): the terminal's firmware ships a system service,
 * package "recieptservice.com.recieptservice". The printer is NOT a Bluetooth or USB device the app can pair with; apps bind to that
 * service and hand it ESC/POS bytes (printEpson), which the service renders and prints.
 *
 * HONESTY RULES
 *  - "connected" means the service really answered getServiceVersion().
 *  - A print is "accepted" only when printEpson() returned without an error. The service does not report paper-out / cover-open /
 *    head-hot to callers, so those cannot be detected and are never claimed; a successful return means "the printer service took the
 *    job", not "paper came out".
 *  - A job id is remembered for a few minutes; repeating the same job id never prints twice.
 *  - Nothing here touches Bluetooth printers or the Android print dialog: other printer types keep working as before.
 */
final class BuiltinPrinter {
    static final String PKG = "recieptservice.com.recieptservice";
    static final String CLS = "recieptservice.com.recieptservice.service.PrinterService";
    private static final int MAX_BYTES = 900 * 1024;            // one Binder transaction must stay under ~1 MB
    private static final long BIND_WAIT_MS = 4000;
    private static final long REMEMBER_MS = 10 * 60 * 1000;

    /** Packages that, when present, are evidence about what kind of terminal this is (shown in diagnostics; only PKG is used to print). */
    static final String[] EVIDENCE_PACKAGES = {
            PKG,
            "com.senraise.printer", "com.senraise.service",
            "woyou.aidlservice.jiuiv5", "com.sunmi.peripheral.printer", "com.sunmi.printerhelper",
            "com.imin.printerservice", "com.pax.neptunelite", "com.telpo.tps550.api",
            "com.android.printspooler", "com.android.bips", "com.google.android.printservice.recommendation"
    };

    private final Context ctx;
    private final Object lock = new Object();
    private PrinterInterface svc;
    private boolean bound;
    private CountDownLatch bindLatch;
    private final Map<String, JSONObject> done = new HashMap<>();   // jobId -> result, for idempotent retries
    private final Map<String, Long> doneAt = new HashMap<>();

    BuiltinPrinter(Context ctx) { this.ctx = ctx.getApplicationContext(); }

    private final ServiceConnection conn = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            synchronized (lock) { svc = PrinterInterface.Stub.asInterface(binder); if (bindLatch != null) bindLatch.countDown(); }
        }
        @Override public void onServiceDisconnected(ComponentName name) { synchronized (lock) { svc = null; } }
        @Override public void onBindingDied(ComponentName name) { synchronized (lock) { svc = null; bound = false; } }
        @Override public void onNullBinding(ComponentName name) { synchronized (lock) { svc = null; if (bindLatch != null) bindLatch.countDown(); } }
    };

    boolean installed() {
        try { ctx.getPackageManager().getPackageInfo(PKG, 0); return true; } catch (Exception e) { return false; }
    }

    /** Binds to the vendor service if needed. Returns null when connected, otherwise the exact reason. */
    private String ensureConnected() {
        synchronized (lock) { if (svc != null && svc.asBinder().isBinderAlive()) return null; svc = null; }
        if (!installed()) return "This terminal does not have the Senraise printer service (" + PKG + "). The built-in printer cannot be used by this app on this device.";
        CountDownLatch latch = new CountDownLatch(1);
        synchronized (lock) {
            bindLatch = latch;
            if (bound) { try { ctx.unbindService(conn); } catch (Exception ignored) { } bound = false; }
            boolean ok = false;
            try {
                Intent i = new Intent(); i.setClassName(PKG, CLS);
                ok = ctx.bindService(i, conn, Context.BIND_AUTO_CREATE);
                if (!ok) { Intent j = new Intent(CLS); j.setPackage(PKG); ok = ctx.bindService(j, conn, Context.BIND_AUTO_CREATE); }
            } catch (SecurityException e) {
                return "Android refused the connection to the printer service (" + e.getMessage() + ").";
            } catch (Exception e) {
                return "Could not start the printer service: " + e.getMessage();
            }
            if (!ok) return "The printer service is installed but would not accept a connection. Restart the terminal and try again.";
            bound = true;
        }
        try { latch.await(BIND_WAIT_MS, TimeUnit.MILLISECONDS); } catch (InterruptedException e) { return "Interrupted while connecting to the printer."; }
        synchronized (lock) { return svc != null ? null : "The printer service did not answer within " + (BIND_WAIT_MS / 1000) + " seconds. Restart the terminal, or check that no other app is holding the printer."; }
    }

    /** Connection + readiness, and the device evidence. Never prints. */
    JSONObject status() {
        JSONObject r = new JSONObject();
        try {
            r.put("ok", true);
            r.put("installed", installed());
            JSONObject dev = new JSONObject();
            dev.put("manufacturer", Build.MANUFACTURER); dev.put("brand", Build.BRAND); dev.put("model", Build.MODEL);
            dev.put("device", Build.DEVICE); dev.put("product", Build.PRODUCT); dev.put("android", Build.VERSION.RELEASE); dev.put("sdk", Build.VERSION.SDK_INT);
            dev.put("fingerprint", Build.FINGERPRINT);
            r.put("device", dev);
            JSONArray pk = new JSONArray();
            PackageManager pm = ctx.getPackageManager();
            for (String p : EVIDENCE_PACKAGES) {
                try { PackageInfo pi = pm.getPackageInfo(p, 0); JSONObject o = new JSONObject(); o.put("package", p); o.put("version", pi.versionName); pk.put(o); } catch (Exception ignored) { }
            }
            r.put("packages", pk);
            String err = ensureConnected();
            if (err != null) { r.put("connected", false); r.put("error", err); return r; }
            r.put("connected", true);
            try {
                String v = svc.getServiceVersion();
                r.put("serviceVersion", v == null ? "" : v);
                r.put("ready", true);
            } catch (Exception e) { r.put("ready", false); r.put("error", "The printer service is not responding: " + e.getMessage()); }
            r.put("paperStatus", "not reported by this printer service");
        } catch (Exception e) {
            try { r.put("ok", false); r.put("error", String.valueOf(e.getMessage())); } catch (Exception ignored) { }
        }
        return r;
    }

    /** Sends ESC/POS bytes. jobId makes the call idempotent: the same id never prints twice (the first result is returned again). */
    JSONObject print(byte[] bytes, String jobId) {
        JSONObject r = new JSONObject();
        try {
            if (bytes == null || bytes.length == 0) { r.put("ok", false); r.put("stage", "input"); r.put("error", "There is nothing to print."); return r; }
            if (bytes.length > MAX_BYTES) { r.put("ok", false); r.put("stage", "input"); r.put("error", "This print is too long for one job (" + (bytes.length / 1024) + " KB). Print it in parts."); return r; }
            synchronized (this) {                                   // one job at a time; a second job waits for the first
                long now = System.currentTimeMillis();
                for (String k : new java.util.ArrayList<>(doneAt.keySet())) if (now - doneAt.get(k) > REMEMBER_MS) { doneAt.remove(k); done.remove(k); }
                if (jobId != null && !jobId.isEmpty() && done.containsKey(jobId)) {
                    JSONObject again = new JSONObject(done.get(jobId).toString());
                    again.put("duplicate", true); again.put("state", "already printed — not sent again");
                    return again;
                }
                String err = ensureConnected();
                if (err != null) { r.put("ok", false); r.put("stage", "connect"); r.put("error", err); return r; }
                try {
                    svc.printEpson(bytes);
                } catch (Exception e) {
                    synchronized (lock) { svc = null; }              // force a fresh connection next time
                    r.put("ok", false); r.put("stage", "send"); r.put("error", "The printer service rejected the job: " + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
                    return r;
                }
                r.put("ok", true); r.put("bytes", bytes.length); r.put("state", "accepted by the printer service (paper-out / cover-open are not reported by this printer)");
                if (jobId != null && !jobId.isEmpty()) { done.put(jobId, new JSONObject(r.toString())); doneAt.put(jobId, now); }
            }
        } catch (Exception e) {
            try { r.put("ok", false); r.put("stage", "send"); r.put("error", String.valueOf(e.getMessage())); } catch (Exception ignored) { }
        }
        return r;
    }

    void release() {
        synchronized (lock) { if (bound) { try { ctx.unbindService(conn); } catch (Exception ignored) { } bound = false; } svc = null; }
    }
}
