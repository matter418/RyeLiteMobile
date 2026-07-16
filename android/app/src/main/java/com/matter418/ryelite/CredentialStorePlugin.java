// Copyright (C) 2025  HighLite / RyeLite contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.

package com.matter418.ryelite;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Login profile store — the mobile counterpart of RyeliteDesktop's
 * userPasswordManagement module (Electron safeStorage).
 *
 * Capacitor front door for tab 1; the store itself (Keystore AES-256-GCM,
 * ciphertext in "ryelite-credentials" SharedPreferences) lives in
 * CredentialVault, shared with RLMBridge for secondary tab WebViews.
 */
@CapacitorPlugin(name = "CredentialStore")
public class CredentialStorePlugin extends Plugin {

    @PluginMethod
    public void list(PluginCall call) {
        JSArray usernames = new JSArray();
        for (String n : CredentialVault.list(getContext())) {
            usernames.put(n);
        }
        JSObject ret = new JSObject();
        ret.put("usernames", usernames);
        ret.put("lastUsed", CredentialVault.getLastUsed(getContext()));
        call.resolve(ret);
    }

    @PluginMethod
    public void get(PluginCall call) {
        String username = call.getString("username");
        if (username == null || username.isEmpty()) {
            call.reject("username is required");
            return;
        }
        JSObject ret = new JSObject();
        ret.put("password", CredentialVault.get(getContext(), username));
        call.resolve(ret);
    }

    @PluginMethod
    public void save(PluginCall call) {
        String username = call.getString("username");
        String password = call.getString("password");
        if (username == null || username.isEmpty() || password == null) {
            call.reject("username and password are required");
            return;
        }
        try {
            CredentialVault.save(getContext(), username, password);
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to encrypt credential: " + e.getMessage());
        }
    }

    @PluginMethod
    public void delete(PluginCall call) {
        String username = call.getString("username");
        if (username == null || username.isEmpty()) {
            call.reject("username is required");
            return;
        }
        CredentialVault.delete(getContext(), username);
        call.resolve();
    }

    @PluginMethod
    public void setLastUsed(PluginCall call) {
        String username = call.getString("username");
        if (username == null || username.isEmpty()) {
            call.reject("username is required");
            return;
        }
        CredentialVault.setLastUsed(getContext(), username);
        call.resolve();
    }
}
