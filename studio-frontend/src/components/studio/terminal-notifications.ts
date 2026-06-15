export interface TerminalNotification {
  id: string;
  projectId: string;
  projectName: string;
  deviceName: string;
  panelId: string;
  tabId: string;
  terminalTitle: string;
  message: string;
  reason?: string;
  createdAt: number;
  read: boolean;
  readAt?: number;
}

export interface TerminalAlertEvent {
  panelId: string;
  tabId: string;
  title: string;
  message?: string;
  reason?: string;
}

export interface NotificationJumpTarget {
  projectId: string;
  panelId: string;
  tabId: string;
  nonce: number;
}
