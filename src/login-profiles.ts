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

// Login profiles — mobile port of RyeliteDesktop's
// src/renderer/client/helpers/userHelper.js. Replaces the username input
// with a dropdown of saved profiles, autofills the last-used profile at
// boot (so a re-login after `adb install -r` is one tap), and saves
// credentials on login when Remember Me is checked.
//
// Passwords never touch localStorage: they live in the CredentialStore
// Capacitor plugin (android/.../CredentialStorePlugin.java), encrypted with
// a non-exportable Android Keystore key.

import { credentialStore as CredentialStore } from './native-bridge';

const NEW_ACCOUNT = '__new__';

let setupRunning = false;

export function initLoginProfiles() {
    // The login menu is created by the game client after boot (and recreated
    // after logout). #rlm-profile-select doubles as the "already set up on
    // this login menu" guard — a detached select from a torn-down menu no
    // longer matches document.querySelector.
    const observer = new MutationObserver(() => {
        if (setupRunning) return;
        if (document.querySelector('#rlm-profile-select')) return;
        if (!document.querySelector('#login-menu-username')) return;
        setupRunning = true;
        setupLoginProfiles()
            .catch(err =>
                console.error('[RyeLite Mobile] Login profile setup failed:', err)
            )
            .finally(() => {
                setupRunning = false;
            });
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

async function setupLoginProfiles() {
    const usernameInput =
        document.querySelector<HTMLInputElement>('#login-menu-username');
    const passwordInput =
        document.querySelector<HTMLInputElement>('#login-menu-password');
    if (!usernameInput || !passwordInput) return;

    const { usernames, lastUsed } = await CredentialStore.list();

    // The login menu can be torn down while list() was in flight.
    if (!usernameInput.isConnected) return;

    // --- Profile dropdown, replacing the username input -------------------
    const profileSelect = document.createElement('select');
    profileSelect.id = 'rlm-profile-select';
    profileSelect.style.height = '2rem';
    profileSelect.style.minHeight = '2rem';
    profileSelect.style.margin = '.1rem 0 .4rem 0';
    profileSelect.style.borderRadius = '1rem';
    profileSelect.style.width = '-webkit-fill-available';
    profileSelect.style.textAlign = 'center';

    for (const username of usernames) {
        const option = document.createElement('option');
        option.value = username;
        option.textContent = username;
        profileSelect.appendChild(option);
    }
    const newOption = document.createElement('option');
    newOption.value = NEW_ACCOUNT;
    newOption.textContent = 'New account…';
    profileSelect.appendChild(newOption);

    usernameInput.parentNode!.insertBefore(profileSelect, usernameInput);

    // --- Remember Me checkbox (game's own checkbox-button styling) --------
    const settingsContainer = document.querySelector(
        '#login-menu-settings-container'
    );
    const rememberCheckbox = document.createElement('button');
    rememberCheckbox.id = 'rlm-remember-checkbox';
    rememberCheckbox.className =
        'login-menu-checkbox-button login-screen-bold-text login-screen-default-text-shadow';
    const rememberLabel = document.createElement('label');
    rememberLabel.className =
        'login-screen-small-text login-screen-default-text-shadow';
    rememberLabel.textContent = 'Remember Me';
    rememberLabel.setAttribute('for', 'rlm-remember-checkbox');

    const isRemembering = () =>
        rememberCheckbox.classList.contains('login-menu-checkbox-button__checked');
    const setRemembering = (on: boolean) => {
        rememberCheckbox.classList.toggle('login-menu-checkbox-button__checked', on);
        rememberCheckbox.textContent = on ? '✓' : '';
    };
    rememberCheckbox.addEventListener('click', () =>
        setRemembering(!isRemembering())
    );
    // Saving is the whole point on mobile — default on.
    setRemembering(true);

    if (settingsContainer) {
        settingsContainer.appendChild(rememberCheckbox);
        settingsContainer.appendChild(rememberLabel);
    }

    // --- Delete-profile button ---------------------------------------------
    const deleteButton = document.createElement('button');
    deleteButton.id = 'rlm-delete-profile';
    deleteButton.className =
        'login-screen-bold-text login-screen-default-text-shadow';
    deleteButton.textContent = 'Delete Saved Login';
    deleteButton.style.color = 'red';
    deleteButton.addEventListener('click', async () => {
        const username = profileSelect.value;
        if (username === NEW_ACCOUNT) return;
        await CredentialStore.delete({ username });
        profileSelect.querySelector(`option[value="${CSS.escape(username)}"]`)?.remove();
        passwordInput.value = '';
        profileSelect.value = NEW_ACCOUNT;
        profileSelect.dispatchEvent(new Event('change'));
    });
    if (settingsContainer && settingsContainer.parentNode) {
        settingsContainer.parentNode.insertBefore(
            deleteButton,
            settingsContainer.nextSibling
        );
    }

    // --- Selection behavior -------------------------------------------------
    profileSelect.addEventListener('change', async () => {
        const username = profileSelect.value;
        if (username === NEW_ACCOUNT) {
            usernameInput.style.display = 'unset';
            usernameInput.value = '';
            passwordInput.value = '';
            deleteButton.style.display = 'none';
            return;
        }
        usernameInput.style.display = 'none';
        usernameInput.value = username;
        deleteButton.style.display = 'unset';
        const { password } = await CredentialStore.get({ username });
        // Guard against a stale response after the user switched profiles.
        if (profileSelect.value === username) {
            passwordInput.value = password ?? '';
        }
    });

    // Autofill: last-used profile if it still exists, else the first saved
    // profile, else the blank new-account form.
    const initial =
        lastUsed && usernames.includes(lastUsed)
            ? lastUsed
            : (usernames[0] ?? NEW_ACCOUNT);
    profileSelect.value = initial;
    profileSelect.dispatchEvent(new Event('change'));

    // --- Save on login --------------------------------------------------------
    const loginButton = Array.from(
        document.getElementsByClassName('login-menu-button')
    ).find(button => button.textContent?.trim() === 'Login') as
        | HTMLElement
        | undefined;

    loginButton?.addEventListener('click', () => {
        const username =
            profileSelect.value === NEW_ACCOUNT
                ? usernameInput.value.trim()
                : profileSelect.value;
        const password = passwordInput.value;
        if (!username) return;

        if (isRemembering() && password) {
            // save() also marks the profile last-used.
            CredentialStore.save({ username, password })
                .then(() => {
                    // Keep the (possibly still-mounted) dropdown in sync.
                    const exists = Array.from(profileSelect.options).some(
                        o => o.value === username
                    );
                    if (!exists) {
                        const option = document.createElement('option');
                        option.value = username;
                        option.textContent = username;
                        profileSelect.insertBefore(option, newOption);
                    }
                })
                .catch(err =>
                    console.error('[RyeLite Mobile] Failed to save login:', err)
                );
        } else {
            CredentialStore.setLastUsed({ username }).catch(() => {});
        }
    });

    // Enter in the password field submits (game doesn't bind it itself).
    passwordInput.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            loginButton?.click();
        }
    });
}
