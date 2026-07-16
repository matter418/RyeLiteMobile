// Copyright (C) 2025  HighLite / RyeLite contributors
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package com.matter418.ryelite;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

// Foreground service that runs ONLY while the activity is paused (started in
// MainActivity.onPause, stopped in onResume). Its sole job is to exempt the
// process from Android's cached-app freezer so the game's WebSocket keeps
// answering server pings while the user is in another app. Same pattern as
// Glimmer's ForegroundService, but declared as specialUse instead of
// dataSync — dataSync is capped at 6h/day on Android 15+ with targetSdk 35.
public class KeepAliveService extends Service {

    private static final int NOTIFICATION_ID = 1;
    private static final String CHANNEL_ID = "RyeLiteKeepAlive";

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        startForegroundWithNotification();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // NOT sticky (deliberate divergence from Glimmer): if Android kills
        // the app, a restarted service would guard a process with no WebView
        // and show a lying "connected" notification (observed 2026-07-14 —
        // zombie process with an empty CDP page list).
        return START_NOT_STICKY;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "Keep game connected",
                    NotificationManager.IMPORTANCE_LOW // silent, no heads-up
            );
            channel.setDescription("Shown while RyeLite keeps your session alive in the background");
            channel.setShowBadge(false);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private void startForegroundWithNotification() {
        try {
            Intent openApp = new Intent(this, MainActivity.class);
            openApp.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            openApp.setAction(Intent.ACTION_MAIN);
            openApp.addCategory(Intent.CATEGORY_LAUNCHER);
            PendingIntent pendingIntent = PendingIntent.getActivity(
                    this, 1000, openApp,
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

            Notification notification = new NotificationCompat.Builder(this, CHANNEL_ID)
                    .setContentTitle("RyeLite")
                    .setContentText("Keeping your game connected")
                    .setSmallIcon(R.drawable.ic_stat_ryelite)
                    .setContentIntent(pendingIntent)
                    .setOngoing(true)
                    .setPriority(NotificationCompat.PRIORITY_LOW)
                    .setCategory(NotificationCompat.CATEGORY_SERVICE)
                    .setAutoCancel(false)
                    .build();

            // Two-arg form uses the manifest-declared foregroundServiceType.
            startForeground(NOTIFICATION_ID, notification);
        } catch (Exception e) {
            stopSelf();
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
