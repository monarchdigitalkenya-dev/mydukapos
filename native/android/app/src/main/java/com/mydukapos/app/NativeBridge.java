package com.mydukapos.app;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothSocket;
import android.content.Context;
import android.os.Build;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.util.Set;
import java.util.UUID;

/**
 * window.MyDukaNative — what the MyDukaPOS web app can ask of the Android app. Every call checks that the page asking is a MyDukaPOS
 * page (never another site opened in the app). Results are REAL: a print is reported as sent only after the bytes were written to the
 * printer's Bluetooth connection; a failure says what failed.
 */
public class NativeBridge {
    private static final UUID SPP = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB");   // Bluetooth serial (ESC/POS printers)
    private final MainActivity act;
    private String pendingBtCallback;
    private BuiltinPrinter builtin;

    NativeBridge(MainActivity act) { this.act = act; }

    private boolean allowed() {
        final boolean[] ok = {false};
        final Object lock = new Object();
        act.runOnUiThread(() -> { synchronized (lock) { ok[0] = act.currentPageIsOurs(); lock.notifyAll(); } });
        synchronized (lock) { try { lock.wait(1500); } catch (InterruptedException e) { return false; } }
        return ok[0];
    }

    private void callback(String id, JSONObject result) {
        if (id == null || id.isEmpty()) return;
        act.js("window.__myDukaNativeCb && window.__myDukaNativeCb(" + JSONObject.quote(id) + ", " + result.toString() + ")");
    }

    @JavascriptInterface
    public String info() {
        try {
            JSONObject o = new JSONObject();
            o.put("platform", "android");
            o.put("module", BuildConfig.MODULE);
            o.put("product", BuildConfig.PRODUCT);
            o.put("appId", BuildConfig.APPLICATION_ID);
            o.put("appName", BuildConfig.APP_NAME);
            o.put("version", BuildConfig.VERSION_NAME);
            o.put("build", BuildConfig.VERSION_CODE);
            o.put("device", Build.MANUFACTURER + " " + Build.MODEL);
            o.put("android", Build.VERSION.RELEASE);
            o.put("bluetooth", adapter() != null);
            o.put("builtinPrinter", builtin().installed());   // the terminal's own printer service is present (not yet proof that it answers)
            return o.toString();
        } catch (Exception e) { return "{}"; }
    }

    /** Android's own print dialog for the page on screen (receipt, report …) — any printer Android can reach (Wi-Fi, PDF, plug-ins). */
    @JavascriptInterface
    public void printPage(String title) {
        if (!allowed()) return;
        act.printCurrentPage(title);
    }

    /** The shop link is forgotten: the launcher asks for one again (Settings ▸ Install App ▸ "Use another shop link"). */
    @JavascriptInterface
    public void forgetShop() {
        if (!allowed()) return;
        act.forgetShop();
    }

    private BluetoothAdapter adapter() {
        BluetoothManager bm = (BluetoothManager) act.getSystemService(Context.BLUETOOTH_SERVICE);
        return bm == null ? null : bm.getAdapter();
    }

    /**
     * The Bluetooth printers this phone is PAIRED with (pair a new printer once in Android Settings ▸ Bluetooth). Answered through the
     * callback: { ok, devices: [{ name, address }] } or { ok:false, error }.
     */
    @SuppressLint("MissingPermission")
    @JavascriptInterface
    public void btList(String cbId) {
        if (!allowed()) return;
        BluetoothAdapter a = adapter();
        JSONObject r = new JSONObject();
        try {
            if (a == null) { r.put("ok", false); r.put("error", "This device has no Bluetooth."); callback(cbId, r); return; }
            if (act.needsBluetoothPermission()) {
                pendingBtCallback = cbId;
                act.requestPermissions(new String[]{"android.permission.BLUETOOTH_CONNECT"}, MainActivity.REQ_BLUETOOTH);
                return;
            }
            if (!a.isEnabled()) { r.put("ok", false); r.put("error", "Bluetooth is off — switch it on, then try again."); callback(cbId, r); return; }
            JSONArray list = new JSONArray();
            Set<BluetoothDevice> bonded = a.getBondedDevices();
            if (bonded != null) for (BluetoothDevice d : bonded) {
                JSONObject o = new JSONObject();
                o.put("name", d.getName() == null ? d.getAddress() : d.getName());
                o.put("address", d.getAddress());
                list.put(o);
            }
            r.put("ok", true); r.put("devices", list);
        } catch (Exception e) {
            try { r.put("ok", false); r.put("error", String.valueOf(e.getMessage())); } catch (Exception ignored) { }
        }
        callback(cbId, r);
    }

    void onBluetoothPermission(boolean granted) {
        String cb = pendingBtCallback;
        pendingBtCallback = null;
        if (cb == null) return;
        if (granted) { btList(cb); return; }
        try { JSONObject r = new JSONObject(); r.put("ok", false); r.put("error", "Bluetooth permission was not given — allow it in Android Settings ▸ Apps ▸ " + BuildConfig.APP_NAME + " ▸ Permissions."); callback(cb, r); } catch (Exception ignored) { }
    }

    /**
     * Sends ESC/POS bytes (base64) to a paired Bluetooth printer. The answer comes only after the bytes were written (ok) or the
     * connection / write failed (ok:false, error) — never assumed.
     */
    @SuppressLint("MissingPermission")
    @JavascriptInterface
    public void btPrint(String address, String base64, String cbId) {
        if (!allowed()) return;
        new Thread(() -> {
            JSONObject r = new JSONObject();
            BluetoothSocket sock = null;
            try {
                BluetoothAdapter a = adapter();
                if (a == null) throw new Exception("This device has no Bluetooth.");
                if (act.needsBluetoothPermission()) throw new Exception("Bluetooth permission is needed (Settings ▸ Printers ▸ choose the printer again).");
                if (!a.isEnabled()) throw new Exception("Bluetooth is off.");
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                BluetoothDevice dev = a.getRemoteDevice(address);
                // zip 340: NO cancelDiscovery() here. On Android 12+ it needs the BLUETOOTH_SCAN permission, which this app never asks for (it only
                // connects to PAIRED printers and never scans), so on a terminal with the "InnerPrinter" device it failed with "Need android.permission.BLUETOOTH_SCAN".
                sock = dev.createRfcommSocketToServiceRecord(SPP);
                sock.connect();                                        // throws if the printer is off / out of range / busy
                OutputStream out = sock.getOutputStream();
                for (int i = 0; i < bytes.length; i += 2048) {         // in chunks: small printer buffers
                    out.write(bytes, i, Math.min(2048, bytes.length - i));
                    out.flush();
                }
                Thread.sleep(300);                                     // let the last chunk leave before closing
                r.put("ok", true); r.put("bytes", bytes.length);
            } catch (Exception e) {
                try { r.put("ok", false); r.put("error", e.getMessage() == null ? "The printer could not be reached." : e.getMessage()); } catch (Exception ignored) { }
            } finally {
                try { if (sock != null) sock.close(); } catch (Exception ignored) { }
            }
            callback(cbId, r);
        }).start();
    }

    private synchronized BuiltinPrinter builtin() { if (builtin == null) builtin = new BuiltinPrinter(act); return builtin; }

    /** The terminal's built-in printer: device evidence, whether the vendor printer service is there and answering. Never prints. */
    @JavascriptInterface
    public void builtinStatus(String cbId) {
        if (!allowed()) return;
        new Thread(() -> callback(cbId, builtin().status())).start();
    }

    /**
     * ESC/POS bytes (base64) to the built-in printer. jobId makes a retry safe: the same id never prints twice. The answer is ok only
     * when the printer service accepted the job; it cannot tell paper-out / cover-open, so the answer never claims paper came out.
     */
    @JavascriptInterface
    public void builtinPrint(String base64, String jobId, String cbId) {
        if (!allowed()) return;
        new Thread(() -> {
            JSONObject r;
            try { r = builtin().print(Base64.decode(base64, Base64.DEFAULT), jobId); }
            catch (Exception e) { r = new JSONObject(); try { r.put("ok", false); r.put("stage", "input"); r.put("error", String.valueOf(e.getMessage())); } catch (Exception ignored) { } }
            callback(cbId, r);
        }).start();
    }
}
