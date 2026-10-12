import { Menu } from 'electron';

export function installChineseMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [
      { label: '关闭窗口', role: 'close' },
      { type: 'separator' },
      { label: '退出', role: 'quit' },
    ] },
    { label: '编辑', submenu: [
      { label: '撤销', role: 'undo' },
      { label: '重做', role: 'redo' },
      { type: 'separator' },
      { label: '剪切', role: 'cut' },
      { label: '复制', role: 'copy' },
      { label: '粘贴', role: 'paste' },
      { label: '全选', role: 'selectAll' },
    ] },
    { label: '视图', submenu: [
      { label: '刷新界面', role: 'reload' },
      { type: 'separator' },
      { label: '实际大小', role: 'resetZoom' },
      { label: '放大', role: 'zoomIn' },
      { label: '缩小', role: 'zoomOut' },
      { label: '切换全屏', role: 'togglefullscreen' },
    ] },
    { label: '窗口', submenu: [
      { label: '最小化', role: 'minimize' },
    ] },
  ]));
}
