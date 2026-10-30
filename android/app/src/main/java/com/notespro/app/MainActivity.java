package com.notespro.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Recibe los PDF que se abren o comparten con NotesPro desde otras apps.
        registerPlugin(SharedFilePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
