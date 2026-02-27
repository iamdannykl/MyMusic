import { useState, useRef, useEffect, ChangeEvent } from 'react'
import './App.css'

export interface MusicFile {
  path: string
  name: string
  artist: string
  duration?: number
}

export type PlayMode = 'listLoop' | 'singleLoop' | 'shuffle'

declare global {
  interface Window {
    showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>
  }
}

// IndexedDB 操作函数
const DB_NAME = 'MusicPlayerDB'
const DB_VERSION = 1
const STORE_NAME = 'directoryHandle'

async function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
    
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
  })
}

async function saveDirHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await openDB()
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    store.put(handle, 'musicDirectory')
    
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => {
        db.close()
        resolve()
      }
      transaction.onerror = () => {
        db.close()
        reject(transaction.error)
      }
    })
  } catch (error) {
    console.error('Failed to save directory handle:', error)
  }
}

async function loadDirHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDB()
    const transaction = db.transaction(STORE_NAME, 'readonly')
    const store = transaction.objectStore(STORE_NAME)
    const request = store.get('musicDirectory')
    
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        db.close()
        resolve(request.result || null)
      }
      request.onerror = () => {
        db.close()
        reject(request.error)
      }
    })
  } catch (error) {
    console.error('Failed to load directory handle:', error)
    return null
  }
}

async function getMusicFilesFromDirectory(dirHandle: FileSystemDirectoryHandle): Promise<MusicFile[]> {
  const musicFiles: MusicFile[] = []
  const allowedExtensions = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']

  try {
    for await (const entry of dirHandle.values()) {
      if (entry.kind === 'file') {
        const ext = entry.name.split('.').pop()?.toLowerCase() || ''
        if (allowedExtensions.includes(ext)) {
          const name = entry.name.replace(/\.[^/.]+$/, '')
          musicFiles.push({
            path: entry.name,
            name,
            artist: 'Unknown Artist',
            duration: undefined,
          })
        }
      }
    }
  } catch (error) {
    console.error('Error reading directory:', error)
  }

  musicFiles.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  return musicFiles
}

function App() {
  const [musicFiles, setMusicFiles] = useState<MusicFile[]>([])
  const [currentSongIndex, setCurrentSongIndex] = useState<number>(-1)
  const [isPlaying, setIsPlaying] = useState<boolean>(false)
  const [currentTime, setCurrentTime] = useState<number>(0)
  const [duration, setDuration] = useState<number>(0)
  const [volume, setVolume] = useState<number>(0.7)
  const [playMode, setPlayMode] = useState<PlayMode>('listLoop')
  const [fileHandles, setFileHandles] = useState<Map<string, FileSystemFileHandle>>(new Map())
  const [audioUrl, setAudioUrl] = useState<string>('')
  const [shuffledIndices, setShuffledIndices] = useState<number[]>([])
  const [shufflePosition, setShufflePosition] = useState<number>(0)
  const [isInitializing, setIsInitializing] = useState<boolean>(true)
  
  const audioRef = useRef<HTMLAudioElement>(null)
  const isAudioLoading = useRef<boolean>(false)

  const currentSong = musicFiles[currentSongIndex]

  // 处理目录并加载音乐文件
  const processMusicDirectory = async (dirHandle: FileSystemDirectoryHandle) => {
    try {
      const files = await getMusicFilesFromDirectory(dirHandle)
      setMusicFiles(files)

      const handles = new Map<string, FileSystemFileHandle>()
      for await (const entry of dirHandle.values()) {
        if (entry.kind === 'file') {
          handles.set(entry.name, entry)
        }
      }
      setFileHandles(handles)

      if (files.length > 0) {
        setCurrentSongIndex(0)
        // Initialize shuffled indices
        const indices = files.map((_, i) => i)
        for (let i = indices.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          ;[indices[i], indices[j]] = [indices[j], indices[i]]
        }
        setShuffledIndices(indices)
      }

      // 保存句柄以便下次使用
      await saveDirHandle(dirHandle)
    } catch (error) {
      console.error('Failed to process music directory:', error)
    }
  }

  // 尝试恢复上次的文件夹
  useEffect(() => {
    const restorePreviousDirectory = async () => {
      try {
        const savedHandle = await loadDirHandle()
        
        if (savedHandle) {
          // 请求权限
          const permission = await savedHandle.queryPermission({ mode: 'read' })
          
          if (permission === 'granted') {
            await processMusicDirectory(savedHandle)
          } else if (permission === 'prompt') {
            const newPermission = await savedHandle.requestPermission({ mode: 'read' })
            if (newPermission === 'granted') {
              await processMusicDirectory(savedHandle)
            }
          }
        }
      } catch (error) {
        console.log('Could not restore previous directory:', error)
      } finally {
        setIsInitializing(false)
      }
    }

    restorePreviousDirectory()
  }, [])

  const loadMusicDirectory = async () => {
    try {
      if (!window.showDirectoryPicker) {
        alert('Your browser does not support the File System Access API. Please use Chrome or Edge.')
        return
      }

      const dirHandle = await window.showDirectoryPicker()
      await processMusicDirectory(dirHandle)
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        console.error('Failed to load music files:', error)
      }
    }
  }

  const getAudioUrl = async (song: MusicFile): Promise<string> => {
    const fileHandle = fileHandles.get(song.path)
    if (fileHandle) {
      const file = await fileHandle.getFile()
      return URL.createObjectURL(file)
    }
    return ''
  }

  const loadAndPlaySong = async (index: number) => {
    if (index < 0 || index >= musicFiles.length) return
    
    isAudioLoading.current = true
    setCurrentSongIndex(index)
    const song = musicFiles[index]
    const url = await getAudioUrl(song)
    setAudioUrl(url)
    
    if (audioRef.current) {
      audioRef.current.src = url
      audioRef.current.load()
      
      // Wait for the audio to be ready, then play
      const playPromise = new Promise<void>((resolve) => {
        const onCanPlay = () => {
          audioRef.current?.removeEventListener('canplay', onCanPlay)
          audioRef.current?.play().then(() => {
            setIsPlaying(true)
            resolve()
          }).catch((err) => {
            console.error('Playback failed:', err)
            setIsPlaying(false)
            resolve()
          })
        }
        audioRef.current?.addEventListener('canplay', onCanPlay)
      })
      
      await playPromise
    }
    
    isAudioLoading.current = false
  }

  const togglePlay = async () => {
    if (!audioRef.current || !currentSong) return

    if (isPlaying) {
      audioRef.current.pause()
      setIsPlaying(false)
    } else {
      try {
        if (audioRef.current.src) {
          await audioRef.current.play()
          setIsPlaying(true)
        }
      } catch (err) {
        console.error('Playback failed:', err)
      }
    }
  }

  const getNextIndex = (): number => {
    if (musicFiles.length === 0) return -1
    
    switch (playMode) {
      case 'shuffle': {
        const nextPos = (shufflePosition + 1) % shuffledIndices.length
        setShufflePosition(nextPos)
        return shuffledIndices[nextPos]
      }
      case 'singleLoop':
        return currentSongIndex
      case 'listLoop':
      default:
        return (currentSongIndex + 1) % musicFiles.length
    }
  }

  const getPrevIndex = (): number => {
    if (musicFiles.length === 0) return -1
    
    switch (playMode) {
      case 'shuffle': {
        const prevPos = shufflePosition <= 0 ? shuffledIndices.length - 1 : shufflePosition - 1
        setShufflePosition(prevPos)
        return shuffledIndices[prevPos]
      }
      case 'singleLoop':
        return currentSongIndex
      case 'listLoop':
      default:
        return (currentSongIndex - 1 + musicFiles.length) % musicFiles.length
    }
  }

  const playNext = async () => {
    const nextIndex = getNextIndex()
    if (nextIndex !== -1) {
      await loadAndPlaySong(nextIndex)
    }
  }

  const playPrev = async () => {
    // If song has played more than 3 seconds, restart it
    if (audioRef.current && audioRef.current.currentTime > 3) {
      audioRef.current.currentTime = 0
      return
    }
    
    const prevIndex = getPrevIndex()
    if (prevIndex !== -1) {
      await loadAndPlaySong(prevIndex)
    }
  }

  const selectSong = async (index: number) => {
    await loadAndPlaySong(index)
  }

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime)
      setDuration(audioRef.current.duration || 0)
    }
  }

  const handleSeek = (e: ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value)
    if (audioRef.current) {
      audioRef.current.currentTime = time
      setCurrentTime(time)
    }
  }

  const handleVolumeChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value)
    setVolume(newVolume)
    if (audioRef.current) {
      audioRef.current.volume = newVolume
    }
  }

  const formatTime = (time: number): string => {
    const minutes = Math.floor(time / 60)
    const seconds = Math.floor(time % 60)
    return `${minutes}:${seconds.toString().padStart(2, '0')}`
  }

  const handleSongEnded = () => {
    if (playMode === 'singleLoop') {
      if (audioRef.current) {
        audioRef.current.currentTime = 0
        audioRef.current.play()
      }
    } else {
      playNext()
    }
  }

  const togglePlayMode = () => {
    setPlayMode((prev) => {
      if (prev === 'listLoop') return 'singleLoop'
      if (prev === 'singleLoop') return 'shuffle'
      return 'listLoop'
    })
  }

  const getPlayModeIcon = () => {
    switch (playMode) {
      case 'listLoop':
        return (
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>
          </svg>
        )
      case 'singleLoop':
        return (
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>
            <text x="12" y="14" fontSize="8" textAnchor="middle" fill="currentColor">1</text>
          </svg>
        )
      case 'shuffle':
        return (
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.42zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>
          </svg>
        )
    }
  }

  const getPlayModeLabel = (): string => {
    switch (playMode) {
      case 'listLoop': return '列表循环'
      case 'singleLoop': return '单曲循环'
      case 'shuffle': return '随机播放'
    }
  }

  return (
    <div className="app">
      <div className="main-container">
        {/* 左侧边栏 - 播放列表 */}
        <aside className="sidebar">
          <div className="sidebar-header">
            <h2>播放列表</h2>
            <button onClick={loadMusicDirectory} className="select-folder-btn">
              选择文件夹
            </button>
          </div>

          <div className="playlist">
            {musicFiles.length === 0 ? (
              <p className="empty-playlist">点击"选择文件夹"开始播放</p>
            ) : (
              <>
                <div className="playlist-count">共 {musicFiles.length} 首歌曲</div>
                {musicFiles.map((song, index) => (
                  <div
                    key={song.path}
                    className={`playlist-item ${index === currentSongIndex ? 'active' : ''}`}
                    onClick={() => selectSong(index)}
                    onDoubleClick={() => selectSong(index)}
                  >
                    <div className="playlist-item-number">
                      {index === currentSongIndex && isPlaying ? (
                        <div className="playing-indicator-small">
                          <span></span>
                          <span></span>
                          <span></span>
                        </div>
                      ) : (
                        index + 1
                      )}
                    </div>
                    <div className="playlist-item-info">
                      <span className="song-name">{song.name}</span>
                      <span className="song-artist">{song.artist}</span>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </aside>

        {/* 右侧 - 播放器 */}
        <main className="player-section">
          <div className="player-wrapper">
            {currentSong && audioUrl ? (
              <>
                <div className="player-header">
                  <div className="cover-art">
                    <div className="cover-placeholder">
                      <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
                      </svg>
                    </div>
                  </div>
                </div>

                <div className="player-body">
                  <div className="song-info">
                    <h1>{currentSong.name}</h1>
                    <p>{currentSong.artist}</p>
                  </div>

                  <div className="progress-section">
                    <div className="progress-container">
                      <span className="time-current">{formatTime(currentTime)}</span>
                      <input
                        type="range"
                        min="0"
                        max={duration || 100}
                        value={currentTime}
                        onChange={handleSeek}
                        className="progress-bar"
                      />
                      <span className="time-total">{formatTime(duration)}</span>
                    </div>
                  </div>

                  <div className="controls-section">
                    <div className="main-controls">
                      <button onClick={playPrev} className="control-btn prev-btn" title="上一首">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                          <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
                        </svg>
                      </button>
                      
                      <button 
                        onClick={togglePlay} 
                        className="control-btn play-btn"
                        title={isPlaying ? '暂停' : '播放'}
                      >
                        {isPlaying ? (
                          <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                        )}
                      </button>
                      
                      <button onClick={playNext} className="control-btn next-btn" title="下一首">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                          <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
                        </svg>
                      </button>
                    </div>

                    <div className="secondary-controls">
                      <div className="mode-control">
                        <button 
                          onClick={togglePlayMode} 
                          className="control-btn mode-btn"
                          title={getPlayModeLabel()}
                        >
                          {getPlayModeIcon()}
                        </button>
                        <span className="mode-label">{getPlayModeLabel()}</span>
                      </div>

                      <div className="volume-section">
                        <svg viewBox="0 0 24 24" fill="currentColor" className="volume-icon">
                          <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z" />
                        </svg>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.01"
                          value={volume}
                          onChange={handleVolumeChange}
                          className="volume-slider"
                        />
                        <span className="volume-value">{Math.round(volume * 100)}%</span>
                      </div>
                    </div>
                  </div>
                </div>

                <audio
                  ref={audioRef}
                  src={audioUrl}
                  onTimeUpdate={handleTimeUpdate}
                  onLoadedMetadata={handleTimeUpdate}
                  onEnded={handleSongEnded}
                  onError={(e) => {
                    console.error('Audio error:', (e.target as HTMLAudioElement).error)
                  }}
                />
              </>
            ) : (
              <div className="no-song">
                {isInitializing ? (
                  <>
                    <div className="loading-spinner">
                      <div className="spinner"></div>
                    </div>
                    <h2>加载中...</h2>
                    <p>正在恢复上次的音乐文件夹</p>
                  </>
                ) : (
                  <>
                    <div className="no-song-icon">
                      <svg viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z" />
                      </svg>
                    </div>
                    <h2>欢迎使用音乐播放器</h2>
                    <p>点击左侧"选择文件夹"按钮开始播放音乐</p>
                  </>
                )}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}

export default App
