package dev.pocketstudio.mobile

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

private val LightColors = lightColorScheme(
    primary = Color(0xFF007A68),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFB9F2E3),
    onPrimaryContainer = Color(0xFF00201A),
    secondary = Color(0xFF4C635D),
    secondaryContainer = Color(0xFFCFE8E0),
    background = Color(0xFFF6F8F7),
    surface = Color.White,
    surfaceVariant = Color(0xFFE6ECE9),
    onSurface = Color(0xFF18201E),
    onSurfaceVariant = Color(0xFF596662),
    outline = Color(0xFFC3CECA),
    outlineVariant = Color(0xFFDFE6E3),
    error = Color(0xFFBA1A1A),
)

private val DarkColors = darkColorScheme(
    primary = Color(0xFF5ED8BE),
    onPrimary = Color(0xFF00382F),
    primaryContainer = Color(0xFF005143),
    onPrimaryContainer = Color(0xFFB9F2E3),
    secondary = Color(0xFFB3CCC4),
    secondaryContainer = Color(0xFF354B45),
    background = Color(0xFF101413),
    surface = Color(0xFF171C1A),
    surfaceVariant = Color(0xFF27302D),
    onSurface = Color(0xFFE5ECE9),
    onSurfaceVariant = Color(0xFFAAB7B3),
    outline = Color(0xFF46534F),
    outlineVariant = Color(0xFF303A37),
    error = Color(0xFFFFB4AB),
)

private val PocketTypography = Typography(
    headlineSmall = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Bold),
    titleLarge = TextStyle(fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = TextStyle(fontSize = 15.sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
    bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 16.sp),
    labelLarge = TextStyle(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
    labelMedium = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium),
)

@Composable
fun PocketTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        typography = PocketTypography,
        content = content,
    )
}

val MonoFamily: FontFamily = FontFamily.Monospace
