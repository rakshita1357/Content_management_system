package com.tvads.player;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Opens the player when the TV starts. See the README for the permission Android 10+ needs for this. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            Intent open = new Intent(context, MainActivity.class);
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(open);
        }
    }
}
