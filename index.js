import { saveSettingsDebounced, eventSource, event_types } from "../../../../script.js";

const ChimePlugin = {
    // 用于在 localStorage 中存储设置的键名
    STORAGE_KEY: "chime_settings",
    // 用于在 localStorage 中存储音频权限状态的键名
    PERMISSION_KEY: "chime_audio_permission",
    // IndexedDB相关配置
    DB_NAME: "ChimeAudioCache",
    DB_VERSION: 1,
    OBJECT_STORE_NAME: "audioFiles",
    
    state: {
        chimeEnabled: new Set(),
        chimeSelect: "default",
        chimeVolume: 1.0,
        customChimes: [],
        // --- 音频核心状态 ---
        audioContext: null, // 音频上下文，用于解决移动端播放限制
        audioElement: null, // 单一的、可复用的Audio元素
        hasAudioPermission: false, // 标记是否已获取音频权限
        currentAudioUrl: null, // 当前使用的音频URL
    },

    // 预设和自定义的音频配置
    CHIME_CONFIG: {
        default: `scripts/extensions/third-party/st-chime/assets/default/true.mp3`,
        doubao: `scripts/extensions/third-party/st-chime/assets/doubao/true.mp3`,
    },

    // 从 localStorage 加载设置
    initSettings() {
        const settings = localStorage.getItem(this.STORAGE_KEY);
        if (settings) {
            const parsed = JSON.parse(settings);
            this.state = {
                ...this.state,
                chimeEnabled: new Set(parsed.chimeEnabled),
                chimeSelect: parsed.chimeSelect || "default",
                chimeVolume: parsed.chimeVolume || 1.0,
                customChimes: parsed.customChimes || []
            };
        }
        // 检查之前是否已授予权限
        this.state.hasAudioPermission = localStorage.getItem(this.PERMISSION_KEY) === "granted";
    },

    // 合并自定义音效到配置中
    mergeCustomChimes() {
        this.state.customChimes.forEach(chime => {
            this.CHIME_CONFIG[chime.id] = chime.url;
        });
    },

    // 初始化数据库
    initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);
            
            request.onerror = (event) => {
                console.error("IndexedDB打开失败:", event.target.error);
                reject(event.target.error);
            };
            
            request.onsuccess = (event) => {
                this.db = event.target.result;
                resolve(this.db);
            };
            
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.OBJECT_STORE_NAME)) {
                    const store = db.createObjectStore(this.OBJECT_STORE_NAME, {
                        keyPath: "id"
                    });
                    // 为URL和文件名创建索引，便于查询
                    store.createIndex("url", "url", { unique: false });
                    store.createIndex("fileName", "fileName", { unique: false });
                }
            };
        });
    },
    
    // 从缓存中获取音频Blob
    getAudioFromCache(id) {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                return reject(new Error("数据库未初始化"));
            }
            
            const transaction = this.db.transaction([this.OBJECT_STORE_NAME], "readonly");
            const store = transaction.objectStore(this.OBJECT_STORE_NAME);
            const request = store.get(id);
            
            request.onsuccess = () => {
                if (request.result) {
                    resolve(request.result.blob);
                } else {
                    resolve(null);
                }
            };
            
            request.onerror = () => {
                reject(new Error("获取缓存音频失败"));
            };
        });
    },
    
    // 缓存音频到IndexedDB
    cacheAudio(id, data, isLocalFile = false, fileName = null) {
        return new Promise(async (resolve, reject) => {
            if (!this.db) {
                await this.initDB();
            }
            
            try {
                // 检查是否已缓存
                const existing = await this.getAudioFromCache(id);
                if (existing) {
                    return resolve(existing);
                }
                
                let blob;
                if (isLocalFile && data instanceof File) {
                    // 处理本地文件
                    blob = data;
                } else if (typeof data === 'string') {
                    // 处理URL
                    const response = await fetch(data);
                    if (!response.ok) {
                        throw new Error(`音频下载失败: ${response.status}`);
                    }
                    blob = await response.blob();
                } else {
                    throw new Error("不支持的音频数据类型");
                }
                
                // 存入IndexedDB
                const transaction = this.db.transaction([this.OBJECT_STORE_NAME], "readwrite");
                const store = transaction.objectStore(this.OBJECT_STORE_NAME);
                const request = store.put({
                    id,
                    url: isLocalFile ? `local://${fileName}` : data,
                    blob,
                    fileName: isLocalFile ? fileName : null,
                    timestamp: new Date().getTime(),
                    isLocal: isLocalFile
                });
                
                request.onsuccess = () => {
                    resolve(blob);
                };
                
                request.onerror = () => {
                    throw new Error("存储音频到缓存失败");
                };
                
                transaction.oncomplete = () => {
                    // 完成事务
                };
                
                transaction.onerror = (event) => {
                    throw new Error(`缓存事务失败: ${event.target.error}`);
                };
            } catch (error) {
                console.error("缓存音频失败:", error);
                reject(error);
            }
        });
    },
    
    // 从缓存或网络获取音频URL对应的Blob
    getAudioBlob(id, url, isLocal = false, fileName = null) {
        return this.getAudioFromCache(id)
            .then(blob => {
                if (blob) {
                    console.log(`从缓存获取音频: ${id}`);
                    return blob;
                }
                console.log(`从${isLocal ? "本地" : "网络"}获取音频: ${url}`);
                return this.cacheAudio(id, url, isLocal, fileName);
            })
            .catch(error => {
                console.error("获取音频失败:", error);
                throw error;
            });
    },
    
    // 生成音频Blob的URL
    createAudioUrl(blob) {
        return URL.createObjectURL(blob);
    },
    
    // 释放音频URL
    revokeAudioUrl(url) {
        if (url) {
            URL.revokeObjectURL(url);
        }
    },
    
    // 创建并渲染设置界面（包含本地导入功能）
    createSettingsUI() {
        const container = $(`
          <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
              <b>更多提醒铃声</b>
              <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
              <div class="chime-toggle-container">
                <label class="chime-toggle-label"><input id="chime_enabled" type="checkbox" /><strong>启用插件</strong></label>
              </div>
              <div class="chime-audio-settings">
                <div class="chime-section-header"><strong>音频设置</strong></div>
                <div class="chime-select-container"><label for="chime_select">音频包：</label><select id="chime_select" class="chime-select"></select></div>
                <div class="chime-test-container"><button id="chime_test" class="chime-test-button"><i class="fa fa-volume-up mr-1"></i>测试音效</button></div>
                <div class="chime-volume-container">
                  <div class="chime-volume-label"><label for="chime_volume">音量：</label><span id="volume_value" class="chime-volume-value">100%</span></div>
                  <input type="range" id="chime_volume" class="chime-volume-slider" min="0" max="1" step="0.05" value="1">
                </div>
                <div id="audio_permission_status" class="chime-permission-status chime-status-info"></div>
              </div>
              <div class="chime-custom-audio">
                <div class="chime-section-header"><strong>自定义音频</strong></div>
                <div class="chime-add-audio">
                  <input type="text" id="custom_audio_name" class="chime-audio-input" placeholder="音频名称">
                  <div class="chime-import-options">
                    <input type="url" id="custom_audio_url" class="chime-audio-input" placeholder="音频URL (MP3格式)">
                    <label for="import_local_audio" class="chime-import-label">
                        <input type="file" id="import_local_audio" accept=".mp3,.wav,.ogg" class="chime-file-input" style="display: none;">
                        <i class="fa-solid fa-upload mr-1"></i>本地导入
                    </label>
                  </div>
                  <button id="add_custom_audio" class="chime-add-button"><i class="fa-solid fa-plus mr-1"></i>添加</button>
                </div>
                <div class="chime-audio-list" id="custom_audio_list"></div>
              </div>
            </div>
          </div>
        `);

        $("#extensions_settings").append(container);

        // 填充下拉选项
        const select = $("#chime_select");
        Object.keys(this.CHIME_CONFIG).forEach(key => {
            const chime = this.state.customChimes.find(c => c.id === key);
            const name = chime?.name || (key === 'default' ? '默认' : '豆包');
            select.append($("<option>").val(key).text(name));
        });
        
        this.updateCustomAudioList();

        // 初始化UI状态
        $("#chime_enabled").prop("checked", this.state.chimeEnabled.has("enabled"));
        $("#chime_select").val(this.state.chimeSelect);
        $("#chime_volume").val(this.state.chimeVolume);
        this.updateVolumeDisplay();
        this.updatePermissionStatus();

        // 绑定事件
        $("#chime_enabled").on("change.chime", this.onChimeEnabled.bind(this));
        $("#chime_select").on("change.chime", this.onChimeSelect.bind(this));
        $("#chime_test").on("click.chime", this.onChimeTest.bind(this));
        $("#chime_volume").on("input.chime", this.onChimeVolume.bind(this));
        $("#add_custom_audio").on("click.chime", this.addCustomAudio.bind(this));
        $(document).on("click.chime", ".chime-remove-button", this.removeCustomAudio.bind(this));
        $("#import_local_audio").on("change.chime", this.handleLocalAudioImport.bind(this));
    },
    
    // 更新权限状态的界面提示
    updatePermissionStatus(msg = "", type = "info") {
        const el = $("#audio_permission_status");
        if (!msg) {
            el.text(this.state.hasAudioPermission ? "已获取音频权限，可自动播放" : "请点击“测试音效”按钮以激活声音");
            el.removeClass("chime-status-success chime-status-warning chime-status-error").addClass(this.state.hasAudioPermission ? "chime-status-success" : "chime-status-warning");
        } else {
            el.text(msg);
            el.removeClass("chime-status-success chime-status-warning chime-status-error").addClass(`chime-status-${type}`);
        }
    },

    // 播放提示音的核心函数
    async playChimeSound() {
        
        if (!this.state.chimeEnabled.has("enabled") || !this.state.hasAudioPermission) {
            return;
        }
        // 确保音频上下文处于运行状态
        if (this.state.audioContext && this.state.audioContext.state === "suspended") {
            await this.state.audioContext.resume();
        }

        const chimeId = this.state.chimeSelect;
        const url = this.CHIME_CONFIG[chimeId];
        if (!url) {
            this.showNotification("音频URL无效", "error");
            return;
        }

        try {
            // 获取音频Blob（从缓存或网络）
            const isLocal = url.startsWith('local://');
            const fileName = isLocal ? url.split('/').pop() : null;
            const blob = await this.getAudioBlob(chimeId, url, isLocal, fileName);
            if (!blob) {
                this.showNotification("无法获取音频数据", "error");
                return;
            }

            // 释放之前的URL（如果有）
            if (this.state.currentAudioUrl) {
                this.revokeAudioUrl(this.state.currentAudioUrl);
            }

            // 生成新的URL并播放
            const audioUrl = this.createAudioUrl(blob);
            this.state.currentAudioUrl = audioUrl;
            this.state.audioElement.src = audioUrl;
            this.state.audioElement.volume = this.state.chimeVolume;
            
            const playPromise = this.state.audioElement.play();

            if (playPromise !== undefined) {
                playPromise.catch(error => {
                    console.error("Chime playback failed:", error);
                    // 如果播放失败，重置状态让用户重新授权
                    this.state.hasAudioPermission = false;
                    localStorage.removeItem(this.PERMISSION_KEY);
                    this.updatePermissionStatus("播放失败，请重试或检查浏览器设置", "error");
                });
            }
        } catch (error) {
            console.error("播放音频时出错:", error);
            this.showNotification("音频播放失败: " + error.message, "error");
        }
    },
    
    // 更新音量滑块的视觉效果
    updateVolumeDisplay() {
        const percent = Math.round(this.state.chimeVolume * 100);
        $("#volume_value").text(`${percent}%`);
        const slider = $("#chime_volume");
        slider.css("background", `linear-gradient(to right, var(--chime-accent) ${percent}%, var(--chime-bg-light) ${percent}%)`);
    },

    // --- 事件处理函数 ---

    onChimeEnabled(e) {
        e.target.checked ? this.state.chimeEnabled.add("enabled") : this.state.chimeEnabled.delete("enabled");
        this.saveSettings();
    },

    onChimeSelect(e) {
        this.state.chimeSelect = $(e.target).val();
        this.saveSettings();
    },

    onChimeVolume(e) {
        this.state.chimeVolume = parseFloat($(e.target).val());
        if (this.state.audioElement) {
            this.state.audioElement.volume = this.state.chimeVolume;
        }
        this.updateVolumeDisplay();
        this.saveSettings();
    },

    // 点击测试按钮，这是获取权限和播放的关键
    async onChimeTest() {
        // 如果音频上下文还未创建（通常是第一次点击），则创建它
        if (!this.state.audioContext) {
            try {
                this.state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
                // 某些严格的浏览器需要通过播放一个无声的buffer来彻底“解锁”
                if (this.state.audioContext.state === 'suspended') {
                    await this.state.audioContext.resume();
                }
            } catch (err) {
                this.updatePermissionStatus("无法初始化音频环境", "error");
                return;
            }
        }

        // 只要用户点击了测试，我们就认为他们授予了权限
        if (!this.state.hasAudioPermission) {
            this.state.hasAudioPermission = true;
            localStorage.setItem(this.PERMISSION_KEY, "granted");
            this.updatePermissionStatus("音频权限已激活！", "success");
        }
        
        this.playChimeSound();
    },
    
    // 处理本地音频导入
    handleLocalAudioImport(e) {
        const file = e.target.files[0];
        if (!file) return;
        
        // 检查文件类型
        const validTypes = ['audio/mp3', 'audio/mpeg', 'audio/wav', 'audio/ogg'];
        if (!validTypes.includes(file.type)) {
            this.showNotification("请选择MP3、WAV或OGG格式的音频文件", "error");
            e.target.value = ''; // 清空文件选择
            return;
        }
        
        // 检查文件大小（可选，避免过大文件）
        if (file.size > 50 * 1024 * 1024) { // 50MB
            this.showNotification("音频文件过大，请选择小于50MB的文件", "error");
            e.target.value = '';
            return;
        }
        
        // 读取文件名并填充到名称输入框
        const nameInput = $("#custom_audio_name");
        nameInput.val(file.name.split('.').slice(0, -1).join('.'));
        
        // 存储文件引用以便添加时使用
        this.tempLocalFile = file;
    },
    
    // --- 自定义音频管理 ---

    async addCustomAudio() {
        const name = $("#custom_audio_name").val().trim();
        let url = $("#custom_audio_url").val().trim();
        let isLocalFile = false;
        let fileName = null;
        
        // 检查是否有本地文件导入
        if (this.tempLocalFile) {
            const file = this.tempLocalFile;
            url = URL.createObjectURL(file); // 创建临时URL
            isLocalFile = true;
            fileName = file.name;
            
            // 导入后清除临时文件引用
            this.tempLocalFile = null;
            $("#import_local_audio").val(''); // 清空文件输入
        }
        
        if (!name) return this.showNotification("音频名称不能为空", "error");
        if (!url && !isLocalFile) return this.showNotification("请输入音频URL或从本地导入", "error");
        
        try {
            // 检查URL有效性（仅对在线URL）
            if (!isLocalFile) {
                new URL(url);
            }
        } catch {
            return this.showNotification("请输入有效的URL", "error");
        }
        
        if (this.state.customChimes.some(c => c.name === name)) {
            return this.showNotification("已存在同名音频", "error");
        }
        
        const id = "custom_" + Date.now();
        
        try {
            // 先缓存音频
            await this.cacheAudio(id, url, isLocalFile, fileName);
            
            // 添加到状态
            this.state.customChimes.push({ 
                id, 
                name, 
                url: isLocalFile ? `local://${fileName}` : url,
                isLocal: isLocalFile
            });
            this.CHIME_CONFIG[id] = isLocalFile ? `local://${fileName}` : url;
            
            // 更新UI
            $("#chime_select").append($("<option>").val(id).text(name));
            this.updateCustomAudioList();

            $("#custom_audio_name").val("");
            $("#custom_audio_url").val("");
            this.saveSettings();
            this.showNotification("音频已添加", "success");
        } catch (error) {
            console.error("添加自定义音频失败:", error);
            this.showNotification("添加音频失败: " + error.message, "error");
        }
    },
    
    removeCustomAudio(e) {
        const id = $(e.currentTarget).closest(".chime-audio-item").data("id");
        
        // 从缓存中删除
        if (this.db) {
            const transaction = this.db.transaction([this.OBJECT_STORE_NAME], "readwrite");
            const store = transaction.objectStore(this.OBJECT_STORE_NAME);
            store.delete(id);
        }
        
        // 原有移除逻辑
        this.state.customChimes = this.state.customChimes.filter(c => c.id !== id);
        delete this.CHIME_CONFIG[id];

        $(`#chime_select option[value="${id}"]`).remove();
        this.updateCustomAudioList();

        if (this.state.chimeSelect === id) {
            this.state.chimeSelect = "default";
            $("#chime_select").val(this.state.chimeSelect);
        }
        this.saveSettings();
        this.showNotification("音频已删除", "success");
    },
    
    updateCustomAudioList() {
        const list = $("#custom_audio_list");
        list.empty();
        if (this.state.customChimes.length > 0) {
            this.state.customChimes.forEach(chime => {
                const source = chime.isLocal ? 
                    `<span class="chime-audio-source chime-status-success"><i class="fa-solid fa-download mr-1"></i>本地</span>` :
                    `<span class="chime-audio-source chime-status-info"><i class="fa-solid fa-link mr-1"></i>在线</span>`;
                
                list.append(`
                  <div class="chime-audio-item" data-id="${chime.id}">
                    <span class="chime-audio-name">${chime.name}</span>
                    ${source}
                    <span class="chime-audio-url">${chime.isLocal ? chime.url.split('/').pop() : chime.url}</span>
                    <button class="chime-remove-button"><i class="fa-solid fa-trash mr-1"></i>删除</button>
                  </div>
                `);
            });
        } else {
            list.append('<div class="chime-empty-list text-gray-500 text-sm">暂无自定义音频</div>');
        }
    },

    // 保存设置到 localStorage
    saveSettings() {
        const settingsToSave = {
            chimeEnabled: Array.from(this.state.chimeEnabled),
            chimeSelect: this.state.chimeSelect,
            chimeVolume: this.state.chimeVolume,
            customChimes: this.state.customChimes
        };
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(settingsToSave));
        saveSettingsDebounced();
    },
    
    // 显示一个短暂的通知
    showNotification(msg, type) {
        const notify = $(`<div class="chime-notification chime-status-${type}">${msg}</div>`);
        $("body").append(notify);
        setTimeout(() => notify.addClass("chime-show"), 10);
        setTimeout(() => {
            notify.removeClass("chime-show");
            setTimeout(() => notify.remove(), 300);
        }, 3000);
    },

    // 处理新消息事件，触发铃声
    handleNewMessageEvent() {
        if (this.state.chimeEnabled.has("enabled") && this.state.hasAudioPermission) {
            this.playChimeSound();
        }
    },

    // 插件入口
    async init() {
        this.initSettings();
        this.mergeCustomChimes();
        
        // 初始化IndexedDB
        try {
            await this.initDB();
            console.log("IndexedDB初始化成功");
        } catch (error) {
            console.error("IndexedDB初始化失败:", error);
            this.showNotification("音频缓存初始化失败", "error");
        }
        
        // 创建并配置唯一的Audio元素
        this.state.audioElement = new Audio();
        this.state.audioElement.volume = this.state.chimeVolume;
        
        const btn = $("#chime_test");
        this.state.audioElement.onplay = () => btn.addClass("animate-pulse");
        this.state.audioElement.onpause = () => btn.removeClass("animate-pulse");
        this.state.audioElement.onended = () => btn.removeClass("animate-pulse");

        // 必须在DOM加载后执行
        jQuery(async () => {
            this.createSettingsUI();
            eventSource.on(event_types.MESSAGE_RECEIVED, this.handleNewMessageEvent.bind(this));
        });
    }
};

ChimePlugin.init();