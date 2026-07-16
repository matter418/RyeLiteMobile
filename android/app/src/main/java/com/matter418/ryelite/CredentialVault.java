// Copyright (C) 2025  HighLite / RyeLite contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package com.matter418.ryelite;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The credential store proper — Keystore-backed AES-256-GCM encryption over
 * the app-private "ryelite-credentials" SharedPreferences. Extracted from
 * CredentialStorePlugin so BOTH front doors share one implementation:
 * the Capacitor plugin (tab 1) and RLMBridge (secondary tab WebViews).
 */
final class CredentialVault {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "ryelite-credential-store";
    private static final String PREFS = "ryelite-credentials";
    static final String LAST_USED_PREF = "__last-used";
    private static final String ENTRY_PREFIX = "cred:";
    private static final int GCM_IV_BYTES = 12; // Keystore GCM ciphers emit 12-byte IVs
    private static final int GCM_TAG_BITS = 128;

    private CredentialVault() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static SecretKey getOrCreateKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        KeyStore.Entry entry = ks.getEntry(KEY_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        kg.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return kg.generateKey();
    }

    private static String encrypt(String plaintext) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] iv = cipher.getIV();
        byte[] ct = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
        byte[] blob = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, blob, 0, iv.length);
        System.arraycopy(ct, 0, blob, iv.length, ct.length);
        return Base64.encodeToString(blob, Base64.NO_WRAP);
    }

    private static String decrypt(String encoded) throws Exception {
        byte[] blob = Base64.decode(encoded, Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(),
                new GCMParameterSpec(GCM_TAG_BITS, blob, 0, GCM_IV_BYTES));
        byte[] plain = cipher.doFinal(blob, GCM_IV_BYTES, blob.length - GCM_IV_BYTES);
        return new String(plain, StandardCharsets.UTF_8);
    }

    static List<String> list(Context context) {
        List<String> names = new ArrayList<>();
        for (String key : prefs(context).getAll().keySet()) {
            if (key.startsWith(ENTRY_PREFIX)) {
                names.add(key.substring(ENTRY_PREFIX.length()));
            }
        }
        Collections.sort(names, String.CASE_INSENSITIVE_ORDER);
        return names;
    }

    static String getLastUsed(Context context) {
        return prefs(context).getString(LAST_USED_PREF, null);
    }

    /** Decrypted password, or null if missing/corrupt (corrupt entries are dropped). */
    static String get(Context context, String username) {
        String encoded = prefs(context).getString(ENTRY_PREFIX + username, null);
        if (encoded == null) {
            return null;
        }
        try {
            return decrypt(encoded);
        } catch (Exception e) {
            // Key invalidated or entry corrupt — drop the entry so the UI
            // treats it as unsaved instead of failing on every login.
            prefs(context).edit().remove(ENTRY_PREFIX + username).apply();
            return null;
        }
    }

    /** save() also marks the profile last-used. */
    static void save(Context context, String username, String password) throws Exception {
        prefs(context).edit()
                .putString(ENTRY_PREFIX + username, encrypt(password))
                .putString(LAST_USED_PREF, username)
                .apply();
    }

    static void delete(Context context, String username) {
        SharedPreferences.Editor edit = prefs(context).edit().remove(ENTRY_PREFIX + username);
        if (username.equals(prefs(context).getString(LAST_USED_PREF, null))) {
            edit.remove(LAST_USED_PREF);
        }
        edit.apply();
    }

    static void setLastUsed(Context context, String username) {
        // Only track profiles that actually exist in the store.
        if (prefs(context).contains(ENTRY_PREFIX + username)) {
            prefs(context).edit().putString(LAST_USED_PREF, username).apply();
        }
    }
}
