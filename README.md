# Antigravity Sync

用于跨设备同步 Google Antigravity 的自定义 **Rules（规则）**、**Skills（技能）**、**常用提示词（Prompts）** 以及 **整理好的对话笔记与产物（Notes / Artifacts）**。

## 目录结构

```text
antigravity-sync/
├── .agents/
│   ├── rules/       # Antigravity 自定义规则（工作区级自动识别）
│   └── skills/      # Antigravity 自定义技能（每个技能一个子目录，含 SKILL.md）
├── prompts/         # 常用提问模板与提示词库
├── notes/           # 重要对话总结、归档的 Artifacts 与知识笔记
├── .gitignore
└── README.md
```

## 首次推送到 GitHub（私有仓库）

1. 在 GitHub 上新建一个 **Private（私有）** 仓库（例如命名为 `antigravity-sync`），创建时**不要**勾选初始化 README 或 `.gitignore`。
2. 在本仓库目录中执行以下命令完成首次提交与推送：

```powershell
# 如果是首次使用 Git，请先设置你的昵称和邮箱（只需执行一次）
git config --global user.name "你的名字"
git config --global user.email "你的邮箱@example.com"

# 提交初始文件
git add .
git commit -m "chore: initialize antigravity-sync repository"

# 关联你的 GitHub 私有仓库并推送（将 URL 替换为你的实际仓库地址）
git remote add origin https://github.com/<你的用户名>/antigravity-sync.git
git branch -M main
git push -u origin main
```

## 在其他设备上同步

### 首次拉取

```bash
git clone https://github.com/<你的用户名>/antigravity-sync.git
```

### 日常同步工作流

* **开始工作前**（拉取最新内容）：
  ```bash
  git pull
  ```
* **更新规则/提示词/笔记后**（推送到云端）：
  ```bash
  git add .
  git commit -m "docs: update prompts and notes"
  git push
  ```

## 与 Antigravity 配合使用建议

* 将本目录设为 Antigravity 的工作区后，Antigravity 会自动发现并加载 `.agents/rules/` 与 `.agents/skills/` 中的自定义配置。
* 遇到有价值的回答或产物（Artifacts），可以让 Antigravity 直接总结并保存到 `notes/` 目录，再通过 Git 同步到其他设备。
