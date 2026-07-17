package dev.pocketstudio.mobile

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class ProfileStore(context: Context) {
    private val prefs = EncryptedSharedPreferences.create(
        context,
        "connection",
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
    fun load() = ConnectionProfile(prefs.getString("server", "").orEmpty(), prefs.getString("token", "").orEmpty())
    fun save(profile: ConnectionProfile) = prefs.edit().putString("server", profile.serverUrl).putString("token", profile.token).apply()
    fun loadChatFontSize() = prefs.getFloat("chat_font_size", 14f).coerceIn(12f, 20f)
    fun saveChatFontSize(value: Float) = prefs.edit().putFloat("chat_font_size", value.coerceIn(12f, 20f)).apply()
    fun clear() = prefs.edit().clear().apply()
}
