package dev.pocketstudio.mobile

import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.graphics.Color as AndroidColor
import android.text.method.LinkMovementMethod
import android.util.TypedValue
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.BackHandler
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.ArrowForward
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.automirrored.rounded.KeyboardReturn
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.rounded.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.lifecycle.viewmodel.compose.viewModel
import io.noties.markwon.Markwon
import io.noties.markwon.AbstractMarkwonPlugin
import io.noties.markwon.core.CorePlugin
import io.noties.markwon.core.MarkwonTheme
import io.noties.markwon.linkify.LinkifyPlugin
import java.text.DateFormat
import java.util.Date
import kotlin.math.roundToInt

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { PocketTheme { PocketApp() } }
    }
}

@Composable private fun PocketApp(vm: MainViewModel = viewModel()) {
    val state by vm.state.collectAsState()
    BackHandler(state.screen != Screen.Login) { vm.back() }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        when (state.screen) {
            Screen.Login -> LoginScreen(state, vm)
            Screen.Devices -> DeviceScreen(state, vm)
            Screen.Projects -> ProjectScreen(state, vm)
            Screen.Conversations -> ConversationScreen(state, vm)
            Screen.Chat -> ChatScreen(state, vm)
            Screen.Terminal -> TerminalScreen(state, vm)
        }
    }
}

@Composable private fun LoginScreen(state: AppState, vm: MainViewModel) {
    var showToken by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().padding(horizontal = 24.dp, vertical = 20.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.size(44.dp)) {
                Box(contentAlignment = Alignment.Center) { Icon(Icons.Rounded.Terminal, null, tint = MaterialTheme.colorScheme.surface) }
            }
            Spacer(Modifier.width(12.dp))
            Column {
                Text("Pocket Studio", style = MaterialTheme.typography.titleLarge)
                Text("Remote ACP workspace", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, fontFamily = MonoFamily)
            }
        }
        Spacer(Modifier.weight(0.75f))
        Text("连接工作区", style = MaterialTheme.typography.headlineSmall)
        Text("使用 Server 地址和 Access Token 访问你的机器与项目。", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp, bottom = 24.dp))
        OutlinedTextField(
            value = state.profile.serverUrl, onValueChange = { vm.updateProfile(it, state.profile.token) },
            label = { Text("Server 地址") }, placeholder = { Text("https://studio.example.com") },
            leadingIcon = { Icon(Icons.Rounded.Dns, null) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next), shape = RoundedCornerShape(8.dp),
        )
        Spacer(Modifier.height(16.dp))
        OutlinedTextField(
            value = state.profile.token, onValueChange = { vm.updateProfile(state.profile.serverUrl, it) },
            label = { Text("Access Token") }, leadingIcon = { Icon(Icons.Rounded.Key, null) },
            trailingIcon = { IconButton(onClick = { showToken = !showToken }) { Icon(if (showToken) Icons.Rounded.VisibilityOff else Icons.Rounded.Visibility, if (showToken) "隐藏 Token" else "显示 Token") } },
            visualTransformation = if (showToken) VisualTransformation.None else PasswordVisualTransformation(), singleLine = true, modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { vm.login() }),
            shape = RoundedCornerShape(8.dp),
        )
        ErrorText(state.error)
        Button(onClick = vm::login, enabled = !state.loading, modifier = Modifier.fillMaxWidth().height(52.dp).padding(top = 4.dp), shape = RoundedCornerShape(8.dp)) {
            if (state.loading) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = Color.White)
            else { Text("连接并登录"); Spacer(Modifier.width(8.dp)); Icon(Icons.AutoMirrored.Rounded.ArrowForward, null, Modifier.size(18.dp)) }
        }
        Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth().padding(top = 16.dp)) {
            Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.Lock, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(10.dp))
                Text("Token 仅加密保存在本机", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Spacer(Modifier.weight(1f))
    }
}

@Composable private fun DeviceScreen(state: AppState, vm: MainViewModel) {
    PageScaffold(title = "机器", subtitle = serverHost(state.profile.serverUrl), onBack = vm::back, loading = state.loading, actions = { RefreshButton(state.loading, vm::refresh) }) {
        if (state.loading && state.serverState.devices.isEmpty()) LoadingState("正在读取机器")
        else if (state.serverState.devices.isEmpty()) EmptyState(Icons.Rounded.Computer, "没有在线机器", "确认 Daemon 已连接到当前 Server")
        else LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(state.serverState.devices, key = { it.id }) { device ->
                ListRow(
                    icon = { StatusIcon(Icons.Rounded.Computer, online = device.status == "online") },
                    title = device.name,
                    subtitle = device.agents.joinToString(" · ") { it.label }.ifBlank { "未报告 ACP Agent" },
                    trailing = "${state.projects.count { it.deviceId == device.id }} 个项目",
                    onClick = { vm.selectDevice(device) },
                )
            }
        }
    }
}

@Composable private fun ProjectScreen(state: AppState, vm: MainViewModel) {
    val projects = state.projects.filter { it.deviceId == state.selectedDevice?.id }
    PageScaffold(title = "项目", subtitle = state.selectedDevice?.name.orEmpty(), onBack = vm::back) {
        if (projects.isEmpty()) EmptyState(Icons.Rounded.FolderOff, "这台机器没有项目", "请先在桌面端创建或登记项目")
        else LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(projects, key = { it.id }) { project ->
                ListRow(
                    icon = { StatusIcon(Icons.Rounded.Folder, online = true) }, title = project.name,
                    subtitle = project.workspacePath, trailing = "", onClick = { vm.selectProject(project) }, monospace = true,
                )
            }
        }
    }
}

@Composable private fun ConversationScreen(state: AppState, vm: MainViewModel) {
    var createMenu by remember { mutableStateOf<CreateMenu?>(null) }
    val project = state.selectedProject
    val conversations = state.projectConversations.sortedByDescending { it.updatedAt }
    val terminals = state.projectTerminals
    PageScaffold(title = "工作区", subtitle = "${state.selectedDevice?.name} / ${project?.name}", onBack = vm::back, loading = state.loading, actions = { RefreshButton(state.loading, vm::refresh) }, floating = {
        FloatingActionButton(onClick = { createMenu = CreateMenu.Root }, shape = RoundedCornerShape(12.dp)) { Icon(Icons.Rounded.Add, "新建") }
    }) {
        if (state.loading && conversations.isEmpty()) LoadingState("正在读取项目对话")
        else if (conversations.isEmpty() && terminals.isEmpty()) EmptyState(Icons.Rounded.Dashboard, "工作区为空", "创建终端或 ACP 会话开始工作")
        else LazyColumn(contentPadding = PaddingValues(16.dp, 16.dp, 16.dp, 88.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (terminals.isNotEmpty()) item { SectionLabel("终端") }
            items(terminals, key = { "terminal:${it.id}" }) { terminal ->
                ListRow(
                    icon = { StatusIcon(Icons.Rounded.Terminal, online = true) }, title = terminal.title,
                    subtitle = "${terminal.type} · ${terminal.path}", trailing = "", onClick = { vm.openTerminal(terminal) }, monospace = true,
                )
            }
            if (conversations.isNotEmpty()) item { SectionLabel("ACP 会话", topPadding = terminals.isNotEmpty()) }
            items(conversations, key = { it.taskId }) { task ->
                ListRow(
                    icon = { StatusIcon(if (task.status in listOf("running", "queued")) Icons.Rounded.Sync else Icons.Rounded.ChatBubbleOutline, task.status in listOf("running", "queued")) },
                    title = task.sessionName.ifBlank { task.prompt.take(40).ifBlank { "未命名对话" } },
                    subtitle = "ACP · ${task.agent} · ${task.terminalType}${task.prompt.takeIf { it.isNotBlank() }?.let { "  ·  $it" }.orEmpty()}", trailing = formatTime(task.updatedAt), onClick = { vm.openConversation(task) },
                )
            }
        }
    }
    when (createMenu) {
        CreateMenu.Root -> CreatePicker(onDismiss = { createMenu = null }, onTerminal = { createMenu = CreateMenu.Terminal }, onAcp = { createMenu = CreateMenu.Acp })
        CreateMenu.Terminal -> TerminalPicker(availableTerminalOptions(state.selectedDevice), onBack = { createMenu = CreateMenu.Root }, onDismiss = { createMenu = null }) { option ->
            createMenu = null; vm.newTerminal(option)
        }
        CreateMenu.Acp -> AgentPicker(state.selectedDevice?.agents.orEmpty().filter { it.name.lowercase().replace("_", "-") in setOf("opencode", "claude", "claude-code", "codex", "kilo", "kilocode", "kilo-code", "qwen", "pi") }, onBack = { createMenu = CreateMenu.Root }, onDismiss = { createMenu = null }) { agent ->
            createMenu = null; vm.newConversation(agent)
        }
        null -> Unit
    }
}

@Composable private fun SectionLabel(text: String, topPadding: Boolean = false) {
    Text(
        text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 4.dp, top = if (topPadding) 12.dp else 0.dp, bottom = 2.dp),
    )
}

@Composable private fun ChatScreen(state: AppState, vm: MainViewModel) {
    var input by remember(state.selectedTask?.taskId) { mutableStateOf("") }
    var attachments by remember(state.selectedTask?.taskId) { mutableStateOf<List<ChatAttachment>>(emptyList()) }
    var showTypography by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) vm.uploadChatImage(uri) { attachment -> attachments = attachments + attachment }
    }
    fun pasteClipboardImage() {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = clipboard.primaryClip
        val uri = if (clip != null && clip.itemCount > 0) clip.getItemAt(0).uri else null
        if (uri == null || !context.contentResolver.getType(uri).orEmpty().startsWith("image/")) {
            vm.showError("剪贴板中没有图片")
            return
        }
        vm.uploadChatImage(uri) { attachment -> attachments = attachments + attachment }
    }
    val listState = rememberLazyListState()
    val task = state.selectedTask
    LaunchedEffect(state.chatItems.size, state.running) {
        val totalItems = state.chatItems.size + if (state.running) 1 else 0
        if (totalItems > 0) listState.animateScrollToItem(totalItems - 1)
    }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            Column(Modifier.background(MaterialTheme.colorScheme.surface).statusBarsPadding()) {
                Row(Modifier.fillMaxWidth().height(60.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = vm::back) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "返回") }
                    Column(Modifier.weight(1f)) {
                        Text(task?.sessionName?.ifBlank { "ACP 对话" } ?: "ACP 对话", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(state.selectedProject?.name.orEmpty(), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                            Box(Modifier.padding(horizontal = 6.dp).size(3.dp).background(MaterialTheme.colorScheme.outlineVariant, CircleShape))
                            Text("ACP · ${task?.agent.orEmpty()} · ${task?.terminalType.orEmpty()}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary, fontFamily = MonoFamily)
                        }
                    }
                    IconButton(onClick = { showTypography = true }) { Icon(Icons.Rounded.TextFields, "调整字体") }
                    Box(
                        Modifier.padding(end = 16.dp).size(9.dp)
                            .background(if (state.connected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, CircleShape)
                            .semantics { stateDescription = if (state.connected) "已连接" else "未连接" },
                    )
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp))
            }
        },
        bottomBar = {
            Column(Modifier.background(MaterialTheme.colorScheme.surface).imePadding().navigationBarsPadding()) {
                ErrorText(state.error, Modifier.padding(horizontal = 16.dp))
                if (attachments.isNotEmpty()) Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    attachments.forEachIndexed { index, attachment ->
                        InputChip(
                            selected = true,
                            onClick = { attachments = attachments.filterIndexed { itemIndex, _ -> itemIndex != index } },
                            label = { Text(attachment.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            trailingIcon = { Icon(Icons.Rounded.Close, "移除", Modifier.size(16.dp)) },
                        )
                    }
                }
                Row(Modifier.fillMaxWidth().widthIn(max = 760.dp).align(Alignment.CenterHorizontally).padding(horizontal = 12.dp, vertical = 9.dp), verticalAlignment = Alignment.Bottom) {
                    IconButton(onClick = { imagePicker.launch("image/*") }, enabled = !state.loading) {
                        Icon(Icons.Rounded.AttachFile, "选择图片")
                    }
                    IconButton(onClick = ::pasteClipboardImage, enabled = !state.loading) {
                        Icon(Icons.Rounded.ContentPaste, "粘贴图片")
                    }
                    OutlinedTextField(
                        value = input, onValueChange = { input = it }, modifier = Modifier.weight(1f),
                        placeholder = { Text(if (state.running) "Agent 完成后可继续发送" else "给 Agent 发送消息") },
                        minLines = 1, maxLines = 5, shape = RoundedCornerShape(6.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    FilledIconButton(
                        onClick = {
                            if (state.running) vm.stop()
                            else if (input.isNotBlank() || attachments.isNotEmpty()) {
                                vm.sendPrompt(input, attachments); input = ""; attachments = emptyList()
                            }
                        },
                        modifier = Modifier.size(50.dp), shape = RoundedCornerShape(8.dp), colors = IconButtonDefaults.filledIconButtonColors(containerColor = if (state.running) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary),
                    ) { Icon(if (state.running) Icons.Rounded.Stop else Icons.AutoMirrored.Rounded.Send, if (state.running) "停止" else "发送") }
                }
            }
        },
    ) { padding ->
        if (state.loading && state.chatItems.isEmpty()) LoadingState("正在加载会话历史", Modifier.padding(padding))
        else if (state.chatItems.isEmpty() && !state.running) EmptyState(Icons.Rounded.AutoAwesome, "开始一段对话", "消息和工具调用会实时显示在这里", Modifier.padding(padding))
        else Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.TopCenter) {
            LazyColumn(Modifier.fillMaxSize().widthIn(max = 760.dp), state = listState, contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                items(state.chatItems, key = { it.id }) { ChatBubble(it, state.chatFontSize) }
                if (state.running) item { RunningIndicator() }
            }
        }
    }
    if (showTypography) FontSizeSheet(state.chatFontSize, onChange = vm::setChatFontSize, onDismiss = { showTypography = false })
}

@Composable private fun TerminalScreen(state: AppState, vm: MainViewModel) {
    var controller by remember(state.selectedTerminal?.id) { mutableStateOf<RemoteTerminalController?>(null) }
    val terminal = state.selectedTerminal
    val imagePicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) vm.uploadTerminalImage(uri) { pasteText -> controller?.send(pasteText) }
    }
    DisposableEffect(terminal?.id) {
        onDispose { controller?.close() }
    }
    Scaffold(
        containerColor = Color(0xFF0B100F),
        topBar = {
            Column(Modifier.background(MaterialTheme.colorScheme.surface).statusBarsPadding()) {
                Row(Modifier.fillMaxWidth().height(60.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = vm::back) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "返回") }
                    Column(Modifier.weight(1f)) {
                        Text(terminal?.title ?: "终端", style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${terminal?.type.orEmpty()} · ${state.selectedProject?.name.orEmpty()}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary, fontFamily = MonoFamily)
                    }
                    IconButton(onClick = { imagePicker.launch("image/*") }, enabled = !state.loading) {
                        Icon(Icons.Rounded.AddPhotoAlternate, "上传图片")
                    }
                    IconButton(onClick = { controller?.clear() }) { Icon(Icons.Rounded.DeleteSweep, "清屏") }
                    Box(Modifier.padding(end = 16.dp).size(9.dp).background(if (state.connected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, CircleShape))
                }
                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp))
            }
        },
        bottomBar = {
            Column(Modifier.background(MaterialTheme.colorScheme.surface).imePadding().navigationBarsPadding()) {
                ErrorText(state.error, Modifier.padding(horizontal = 12.dp))
                TerminalVirtualKeyboard(controller)
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { context ->
                    RemoteTerminalController(context, vm.terminalUrl(), vm::terminalOpened, vm::terminalClosed, vm::terminalError)
                        .also { controller = it }.viewport
                },
            )
            if (state.loading) LinearProgressIndicator(Modifier.fillMaxWidth().align(Alignment.TopCenter).height(2.dp))
        }
    }
}

@Composable private fun TerminalVirtualKeyboard(controller: RemoteTerminalController?) {
    var ctrl by remember { mutableStateOf(false) }
    var alt by remember { mutableStateOf(false) }
    var meta by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 6.dp, vertical = 5.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            TerminalKeycap("Esc", 1f) { controller?.send("\u001b") }
            TerminalKeycap("Tab", 1f) { controller?.send("\t") }
            TerminalKeycap("Ctrl", 1.15f, ctrl) {
                ctrl = !ctrl
                controller?.setControlModifier(ctrl)
            }
            TerminalKeycap("Win", 1.05f, meta) {
                meta = !meta
                controller?.setMetaModifier(meta)
            }
            TerminalKeycap("Alt", 1f, alt) {
                alt = !alt
                controller?.setAltModifier(alt)
            }
            TerminalKeycap("Home", 1.15f) { controller?.send("\u001b[H") }
            TerminalKeycap("End", 1f) { controller?.send("\u001b[F") }
            TerminalKeycap("Del", 1f) { controller?.send("\u001b[3~") }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            TerminalKeycap("PgUp", 1.2f) { controller?.send("\u001b[5~") }
            TerminalKeycap("PgDn", 1.2f) { controller?.send("\u001b[6~") }
            TerminalIconKey(Icons.AutoMirrored.Rounded.KeyboardArrowLeft, "左", 1f) { controller?.send("\u001b[D") }
            TerminalIconKey(Icons.Rounded.KeyboardArrowDown, "下", 1f) { controller?.send("\u001b[B") }
            TerminalIconKey(Icons.Rounded.KeyboardArrowUp, "上", 1f) { controller?.send("\u001b[A") }
            TerminalIconKey(Icons.AutoMirrored.Rounded.KeyboardArrowRight, "右", 1f) { controller?.send("\u001b[C") }
            TerminalIconKey(Icons.AutoMirrored.Rounded.KeyboardReturn, "回车", 1.35f) { controller?.send("\r") }
        }
    }
}

@Composable private fun RowScope.TerminalKeycap(label: String, weight: Float, active: Boolean = false, onClick: () -> Unit) {
    Surface(
        modifier = Modifier.weight(weight).height(43.dp).clickable(onClick = onClick), shape = RoundedCornerShape(5.dp),
        color = if (active) MaterialTheme.colorScheme.primary else Color(0xFF252D2B),
        border = BorderStroke(1.dp, if (active) MaterialTheme.colorScheme.primary else Color(0xFF45514D)),
    ) { Box(contentAlignment = Alignment.Center) { Text(label, color = if (active) MaterialTheme.colorScheme.onPrimary else Color(0xFFD7E2DE), fontFamily = MonoFamily, fontSize = 11.sp, maxLines = 1) } }
}

@Composable private fun RowScope.TerminalIconKey(icon: androidx.compose.ui.graphics.vector.ImageVector, description: String, weight: Float, onClick: () -> Unit) {
    Surface(
        modifier = Modifier.weight(weight).height(43.dp).clickable(onClick = onClick), shape = RoundedCornerShape(5.dp),
        color = Color(0xFF252D2B), border = BorderStroke(1.dp, Color(0xFF45514D)),
    ) { Box(contentAlignment = Alignment.Center) { Icon(icon, description, tint = Color(0xFFD7E2DE), modifier = Modifier.size(20.dp)) } }
}


@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun PageScaffold(title: String, subtitle: String, onBack: () -> Unit, loading: Boolean = false, actions: @Composable RowScope.() -> Unit = {}, floating: @Composable () -> Unit = {}, content: @Composable (PaddingValues) -> Unit) {
    Scaffold(containerColor = MaterialTheme.colorScheme.background, floatingActionButton = floating, topBar = {
        Column {
            TopAppBar(
                title = { Column { Text(title, style = MaterialTheme.typography.headlineSmall); Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis) } },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "返回") } },
                actions = actions, colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
            )
            if (loading) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp))
        }
    }) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            Box(Modifier.fillMaxHeight().fillMaxWidth().widthIn(max = 760.dp).align(Alignment.TopCenter)) { content(PaddingValues(0.dp)) }
        }
    }
}

@Composable private fun ListRow(icon: @Composable () -> Unit, title: String, subtitle: String, trailing: String, onClick: () -> Unit, monospace: Boolean = false) {
    Surface(
        Modifier.fillMaxWidth().heightIn(min = 76.dp).clickable(onClick = onClick),
        shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.surface,
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            icon(); Spacer(Modifier.width(12.dp)); Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.height(3.dp))
                Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, fontFamily = if (monospace) MonoFamily else FontFamily.Default, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (trailing.isNotBlank()) Text(trailing, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp))
            Icon(Icons.Rounded.ChevronRight, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
        }
    }
}

@Composable private fun StatusIcon(icon: androidx.compose.ui.graphics.vector.ImageVector, online: Boolean) {
    Box(
        Modifier.size(40.dp).background(if (online) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp)),
        contentAlignment = Alignment.Center,
    ) { Icon(icon, null, tint = if (online) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp)) }
}

@Composable private fun ChatBubble(item: ChatItem, fontSize: Float) {
    val user = item.role == "user"
    val tool = item.kind == "tool"
    if (tool) {
        ToolBubble(item, fontSize)
        return
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (user) Arrangement.End else Arrangement.Start) {
        if (!user) {
            Box(Modifier.padding(top = 3.dp).size(26.dp).background(MaterialTheme.colorScheme.primaryContainer, CircleShape), contentAlignment = Alignment.Center) {
                Icon(Icons.Rounded.AutoAwesome, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(14.dp))
            }
            Spacer(Modifier.width(10.dp))
        }
        Surface(
            modifier = if (user) Modifier.widthIn(max = 330.dp) else Modifier.weight(1f),
            shape = RoundedCornerShape(6.dp),
            color = when { user -> MaterialTheme.colorScheme.onSurface; item.kind == "error" -> MaterialTheme.colorScheme.errorContainer; else -> Color.Transparent },
        ) {
            Column(Modifier.padding(horizontal = if (user) 13.dp else 0.dp, vertical = if (user) 10.dp else 0.dp)) {
                if (user) Text(item.text, color = MaterialTheme.colorScheme.surface, fontSize = fontSize.sp, lineHeight = (fontSize * 1.42f).sp)
                else MarkdownText(item.text, fontSize)
            }
        }
    }
}

@Composable private fun ToolBubble(item: ChatItem, fontSize: Float) {
    var expanded by remember(item.id) { mutableStateOf(false) }
    Surface(
        modifier = Modifier.fillMaxWidth().clickable { expanded = !expanded }.semantics { stateDescription = if (expanded) "已展开" else "已折叠" },
        shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.surface,
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(28.dp).background(MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(6.dp)), contentAlignment = Alignment.Center) {
                    Icon(Icons.Rounded.Terminal, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
                }
                Spacer(Modifier.width(8.dp))
                Text(item.title.ifBlank { "工具调用" }, fontWeight = FontWeight.Medium, fontSize = 13.sp, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                Icon(if (expanded) Icons.Rounded.ExpandLess else Icons.Rounded.ExpandMore, if (expanded) "折叠" else "展开", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
            }
            if (expanded && item.text.isNotBlank()) {
                HorizontalDivider(Modifier.padding(vertical = 8.dp), color = MaterialTheme.colorScheme.outlineVariant)
                Text(item.text, fontFamily = MonoFamily, fontSize = maxOf(11f, fontSize - 2f).sp, lineHeight = maxOf(16f, fontSize * 1.3f).sp)
            }
        }
    }
}

@Composable private fun MarkdownText(markdown: String, fontSize: Float) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val onSurface = MaterialTheme.colorScheme.onSurface.toArgb()
    val primary = MaterialTheme.colorScheme.primary.toArgb()
    val codeBackground = MaterialTheme.colorScheme.surfaceVariant.toArgb()
    val markwon = remember(context, primary, codeBackground) {
        Markwon.builder(context)
            .usePlugin(CorePlugin.create())
            .usePlugin(LinkifyPlugin.create())
            .usePlugin(object : AbstractMarkwonPlugin() {
                override fun configureTheme(builder: MarkwonTheme.Builder) {
                    builder.headingTextSizeMultipliers(floatArrayOf(1.55f, 1.35f, 1.2f, 1.12f, 1.06f, 1f))
                        .headingBreakHeight(0)
                        .linkColor(primary)
                        .codeBackgroundColor(codeBackground)
                        .codeBlockBackgroundColor(codeBackground)
                }
            })
            .build()
    }
    AndroidView(
        factory = {
            TextView(it).apply {
                setTextColor(onSurface)
                setTextSize(TypedValue.COMPLEX_UNIT_SP, fontSize)
                setLineSpacing(0f, 1.22f)
                movementMethod = LinkMovementMethod.getInstance()
                includeFontPadding = false
                setBackgroundColor(AndroidColor.TRANSPARENT)
            }
        },
        update = {
            it.setTextColor(onSurface)
            it.setTextSize(TypedValue.COMPLEX_UNIT_SP, fontSize)
            markwon.setMarkdown(it, markdown)
        },
        modifier = Modifier.fillMaxWidth(),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun FontSizeSheet(value: Float, onChange: (Float) -> Unit, onDismiss: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("聊天字体", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                Text("${value.toInt()} sp", color = MaterialTheme.colorScheme.primary, fontFamily = MonoFamily)
            }
            Spacer(Modifier.height(14.dp))
            Surface(color = MaterialTheme.colorScheme.surfaceVariant, shape = RoundedCornerShape(8.dp), modifier = Modifier.fillMaxWidth()) {
                MarkdownText("正文预览，支持 **粗体**、`code` 与列表。", value)
            }
            Slider(
                value = value,
                onValueChange = { onChange(it.roundToInt().toFloat()) },
                valueRange = 12f..20f,
                steps = 7,
                modifier = Modifier.padding(vertical = 12.dp),
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("小", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("大", fontSize = 18.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Spacer(Modifier.navigationBarsPadding().height(20.dp))
        }
    }
}

@Composable private fun RunningIndicator() {
    Row(verticalAlignment = Alignment.CenterVertically) { CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp); Spacer(Modifier.width(8.dp)); Text("Agent 正在处理", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall) }
}

@Composable private fun LoadingState(label: String, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.5.dp)
        Spacer(Modifier.height(12.dp))
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable private fun EmptyState(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, detail: String, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(icon, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(36.dp)); Spacer(Modifier.height(14.dp)); Text(title, style = MaterialTheme.typography.titleLarge); Text(detail, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 6.dp))
    }
}

@Composable private fun ErrorText(error: String, modifier: Modifier = Modifier) {
    if (error.isNotBlank()) Surface(color = MaterialTheme.colorScheme.errorContainer, shape = RoundedCornerShape(8.dp), modifier = modifier.padding(vertical = 8.dp)) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Rounded.ErrorOutline, null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(8.dp))
            Text(error, color = MaterialTheme.colorScheme.onErrorContainer, style = MaterialTheme.typography.bodySmall)
        }
    }
}
@Composable private fun RefreshButton(loading: Boolean, refresh: () -> Unit) { IconButton(onClick = refresh, enabled = !loading) { Icon(Icons.Rounded.Refresh, "刷新", tint = if (loading) MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f) else LocalContentColor.current) } }

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun CreatePicker(onDismiss: () -> Unit, onTerminal: () -> Unit, onAcp: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Text("新建", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
        PickerRow(Icons.Rounded.Terminal, "终端类型", "创建 CLI 终端 tab", onTerminal)
        PickerRow(Icons.Rounded.AutoAwesome, "ACP 会话", "创建移动端 Agent 对话", onAcp)
        Spacer(Modifier.navigationBarsPadding().height(16.dp))
    }
}

@Composable private fun PickerRow(icon: androidx.compose.ui.graphics.vector.ImageVector, title: String, subtitle: String, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(title) }, supportingContent = { Text(subtitle) },
        leadingContent = { Icon(icon, null, tint = MaterialTheme.colorScheme.primary) },
        trailingContent = { Icon(Icons.Rounded.ChevronRight, null) }, modifier = Modifier.clickable(onClick = onClick),
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun TerminalPicker(options: List<TerminalOption>, onBack: () -> Unit, onDismiss: () -> Unit, onPick: (TerminalOption) -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        PickerHeader("终端类型", onBack)
        options.forEach { option ->
            ListItem(
                headlineContent = { Text(option.label) }, supportingContent = { Text(option.command.ifBlank { "Shell" }, fontFamily = MonoFamily) },
                leadingContent = { Icon(Icons.Rounded.Terminal, null, tint = MaterialTheme.colorScheme.primary) },
                trailingContent = { Icon(Icons.Rounded.Add, "创建") }, modifier = Modifier.clickable { onPick(option) },
            )
        }
        Spacer(Modifier.navigationBarsPadding().height(16.dp))
    }
}

@Composable private fun PickerHeader(title: String, onBack: () -> Unit) {
    Row(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "返回") }
        Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(start = 4.dp))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun AgentPicker(agents: List<AgentCapability>, onBack: () -> Unit, onDismiss: () -> Unit, onPick: (String) -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        PickerHeader("ACP 会话", onBack)
        if (agents.isEmpty()) Text("这台机器没有报告可用的 ACP Agent", color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(20.dp))
        agents.forEach { agent ->
            ListItem(
                headlineContent = { Text(agent.label) }, supportingContent = { Text(agent.name, fontFamily = MonoFamily) },
                leadingContent = { Icon(Icons.Rounded.AutoAwesome, null, tint = MaterialTheme.colorScheme.primary) }, trailingContent = { Icon(Icons.Rounded.ChevronRight, null) },
                modifier = Modifier.clickable { onPick(agent.name) },
            )
        }
        Spacer(Modifier.navigationBarsPadding().height(16.dp))
    }
}

private enum class CreateMenu { Root, Terminal, Acp }

private fun serverHost(value: String) = runCatching { java.net.URI(value).host }.getOrNull() ?: value
private fun formatTime(seconds: Long): String = if (seconds <= 0) "" else DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(seconds * 1000))
