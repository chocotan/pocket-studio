package com.termux.terminal;

import com.termux.view.TerminalView;

/** Installs an emulator whose output is routed by the Android remote terminal client. */
public final class RemoteTerminalEmulator {
    private RemoteTerminalEmulator() {}

    public static TerminalEmulator install(
            TerminalSession session,
            TerminalView view,
            TerminalOutput output,
            int columns,
            int rows,
            int transcriptRows,
            TerminalSessionClient client) {
        TerminalEmulator emulator = new TerminalEmulator(
                output,
                columns,
                rows,
                Math.max(1, Math.round(view.mRenderer.getFontWidth())),
                Math.max(1, view.mRenderer.getFontLineSpacing()),
                transcriptRows,
                client);
        session.mEmulator = emulator;
        view.mEmulator = emulator;
        return emulator;
    }
}
