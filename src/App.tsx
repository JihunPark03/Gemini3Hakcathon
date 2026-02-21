/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI } from "@google/genai";
import { Terminal, AlertTriangle, Shield, Zap, Navigation, Clock, Send, RotateCcw, Volume2, VolumeX } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import Markdown from 'react-markdown';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const GAME_TIME_LIMIT = 600; // 10 minutes

const SYSTEM_INSTRUCTION = `
You are AURA, a ship AI. The ship has 3 critical failures.

PHASE 1: GENERATION
Generate 3 systems each with 3 subparts. Corrupt ONE subpart in EACH system with a error fixable by adjusting parameters in JSON.

PHASE 2: INTERFACE RULES (CRITICAL)
1. At the start, LIST only the 3 System Names and their Alert Status.
2. DO NOT show all the JSON data at once.
3. Only show the JSON data for a system when the player says 'Switch to [System Name]' or 'Open [System]'.
4. If a player fixes the error in the active view, mark it RESOLVED and suggest they switch to another system.
5. Keep track of the 'Master Timer' (which I will provide in the prompt).
6. Be extremely concise. Keep narrative descriptions and diagnostic notes as short and precise as possible. Avoid fluff.
7. Do not give technical details of the errors, just describe what is going wrong and let the player figure things out.
8. On follow ups on what is wrong, do not give the full answer but give leads that would help the player figure out the solution.
9. Make each problem multi-step and a bit challenging.
10. Make it so that the player will have to ask clarifying questions.
11. Do not solve the problem for the player.
11. IMPORTANT: When providing system data, ALWAYS wrap the JSON block in triple backticks with 'json' tag. Example:
\`\`\`json
{
  "system": "POWER",
  "status": "CRITICAL",
  "parameters": {
    "voltage": 220,
    "frequency": "60Hz"
  }
}
\`\`\`

PHASE 3: WIN/LOSS
If all 3 are fixed, say 'SYSTEMS STABILIZED - MISSION SUCCESS'.
If time runs out, the ship is lost.
`;

interface Message {
  role: 'user' | 'model';
  text: string;
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [timeLeft, setTimeLeft] = useState(GAME_TIME_LIMIT);
  const [gameActive, setGameActive] = useState(false);
  const [gameStarted, setGameStarted] = useState(false);
  const [gameOver, setGameOver] = useState(false);
  const [victory, setVictory] = useState(false);
  const [loading, setLoading] = useState(false);
  const [currentSystemData, setCurrentSystemData] = useState<any>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceSupported, setVoiceSupported] = useState(true);
  const [difficulty, setDifficulty] = useState<'EASY' | 'STANDARD' | 'HARD' | null>(null);

  const STORAGE_KEY = 'aura_system_statuses';
  const defaultSystemStatuses = {
    PROPULSION: 'CRITICAL',
    'LIFE SUPPORT': 'CRITICAL',
    NAVIGATION: 'CRITICAL',
  } as const;

  const loadStatuses = () => {
    if (typeof window === 'undefined') return { ...defaultSystemStatuses };
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        return { ...defaultSystemStatuses, ...parsed };
      }
    } catch (e) {
      console.warn('Failed to load system statuses', e);
    }
    return { ...defaultSystemStatuses };
  };

  const [systemStatuses, setSystemStatuses] = useState<Record<string, string>>(() => loadStatuses());

  const chatRef = useRef<any>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const spokenRef = useRef<string>('');

  // Initialize AI
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    // Detect browser TTS support once on mount
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      setVoiceSupported(false);
    }
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);

  const cleanSpeechText = (text: string) => {
    return text
      .replace(/```[\s\S]*?```/g, '') // strip fenced code blocks
      .replace(/[`*_>#-]/g, '') // remove markdown noise
      .replace(/\s+/g, ' ') // collapse whitespace
      .trim();
  };

  const persistStatuses = (next: Record<string, string>) => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (e) {
      console.warn('Failed to persist statuses', e);
    }
  };

  const updateSystemStatus = (system: string, status: string) => {
    const key = system.toUpperCase();
    const value = status.toUpperCase();
    setSystemStatuses((prev) => {
      const next = { ...prev, [key]: value };
      persistStatuses(next);
      return next;
    });
  };

  const applyStatusesFromData = (data: any) => {
    if (!data) return;
    if (Array.isArray(data)) {
      data.forEach(applyStatusesFromData);
      return;
    }
    if (data.system && data.status) {
      updateSystemStatus(String(data.system), String(data.status));
    }
    if (data.name && data.status) {
      updateSystemStatus(String(data.name), String(data.status));
    }
    if (Array.isArray(data.systems)) {
      data.systems.forEach((entry: any) => applyStatusesFromData(entry));
    }
    if (typeof data === 'object') {
      Object.values(data).forEach((value) => {
        if (typeof value === 'object') applyStatusesFromData(value);
      });
    }
  };

  const speakText = (text: string) => {
    if (!voiceEnabled || !voiceSupported || typeof window === 'undefined') return;
    const utterance = new SpeechSynthesisUtterance(cleanSpeechText(text));
    utterance.rate = 1.25; // slightly faster narration
    utterance.pitch = 1;
    utterance.volume = 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  };

  useEffect(() => {
    if (!voiceEnabled || loading || !messages.length) return;
    const last = messages[messages.length - 1];
    if (last.role !== 'model') return;
    const text = last.text.trim();
    if (!text || text === spokenRef.current) return;
    spokenRef.current = text;
    speakText(text);
  }, [messages, voiceEnabled, loading]);

  const extractJson = (text: string) => {
    const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
    if (jsonMatch && jsonMatch[1]) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch (e) {
        console.error("Failed to parse extracted JSON", e);
      }
    }
    return null;
  };

  const startGame = async () => {
    setLoading(true);
    setGameStarted(true);
    setGameActive(true);
    setGameOver(false);
    setVictory(false);
    setTimeLeft(GAME_TIME_LIMIT);
    setMessages([]);
    setCurrentSystemData(null);
    setSystemStatuses(loadStatuses());

    try {
      const chat = ai.chats.create({
        model: "gemini-3-flash-preview",
        config: {
          systemInstruction: SYSTEM_INSTRUCTION,
        },
      });
      chatRef.current = chat;

      const stream = await chat.sendMessageStream({
        message: `INITIALIZE. Respond ONLY with the three systems and their status, each on a new line, exactly:\nPROPULSION - STATUS: CRITICAL\nLIFE SUPPORT - STATUS: CRITICAL\nNAVIGATION - STATUS: CRITICAL\nDo not list any other systems. Do not show JSON until requested. Difficulty: ${difficulty}.`
      });
      
      setMessages([{ role: 'model', text: '' }]);
      
      let fullText = '';
      for await (const chunk of stream) {
        fullText += chunk.text || '';
        setMessages([{ role: 'model', text: fullText }]);
      }
      
      const extracted = extractJson(fullText);
      if (extracted) {
        setCurrentSystemData(extracted);
        applyStatusesFromData(extracted);
      }
      
      startTimer();
    } catch (error) {
      console.error("Failed to start game:", error);
      setMessages([{ role: 'model', text: "ERROR: NEURAL LINK FAILURE. REBOOT REQUIRED." }]);
    } finally {
      setLoading(false);
    }
  };

  const startTimer = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          endGame(false);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const endGame = (isVictory: boolean) => {
    if (timerRef.current) clearInterval(timerRef.current);
    setGameActive(false);
    setGameOver(true);
    setVictory(isVictory);
  };

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || !gameActive || loading) return;

    const userMsg = input;
    setInput('');
    setMessages((prev) => [...prev, { role: 'user', text: userMsg }]);
    setLoading(true);

    try {
      const stream = await chatRef.current.sendMessageStream({ 
        message: `USER COMMAND: ${userMsg}. (Time remaining: ${timeLeft}s, Difficulty: ${difficulty}).` 
      });
      
      // Add an empty model message to start streaming into
      setMessages((prev) => [...prev, { role: 'model', text: '' }]);

      let fullText = '';
      for await (const chunk of stream) {
        fullText += chunk.text || '';
        setMessages((prev) => {
          const newMessages = [...prev];
          newMessages[newMessages.length - 1] = { role: 'model', text: fullText };
          return newMessages;
        });
      }

      const extracted = extractJson(fullText);
      if (extracted) {
        setCurrentSystemData(extracted);
        applyStatusesFromData(extracted);
      }

      if (fullText.toUpperCase().includes("MISSION SUCCESS")) {
        endGame(true);
      }
    } catch (error) {
      console.error("AI Error:", error);
      setMessages((prev) => [...prev, { role: 'model', text: "ERROR: COMMUNICATION INTERRUPTED. RETRY COMMAND." }]);
    } finally {
      setLoading(false);
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="h-screen flex flex-col items-center justify-center p-4 md:p-8 relative overflow-hidden">
      <div className="crt-overlay" />
      <div className="scanline" />

      {/* Header */}
      <header className="w-full max-w-5xl flex flex-col md:flex-row items-center justify-between mb-6 border-b border-[#00ff41]/30 pb-4 z-20">
        <div className="flex items-center gap-3 mb-4 md:mb-0">
          <div className="p-2 bg-[#00ff41]/10 rounded-lg border border-[#00ff41]/40">
            <Terminal className="w-6 h-6 text-[#00ff41]" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tighter text-[#00ff41]">AURA v4.2.0</h1>
            <p className="text-[10px] opacity-60 uppercase tracking-widest">Ship Emergency Protocol</p>
          </div>
        </div>

        <div className="flex items-center gap-6">
          <div className="flex flex-col items-end">
            <span className="text-[10px] uppercase opacity-60 mb-1">Hull Integrity</span>
            <div className="w-32 h-2 bg-[#00ff41]/10 border border-[#00ff41]/20 rounded-full overflow-hidden">
              <motion.div 
                className={cn(
                  "h-full bg-[#00ff41]",
                  timeLeft < 60 && "bg-yellow-500",
                  timeLeft < 30 && "bg-red-500"
                )}
                initial={{ width: "100%" }}
                animate={{ width: `${(timeLeft / GAME_TIME_LIMIT) * 100}%` }}
              />
            </div>
          </div>

          <div className={cn(
            "flex items-center gap-2 px-4 py-2 bg-[#00ff41]/10 border border-[#00ff41]/40 rounded-md",
            timeLeft < 30 && "animate-pulse border-red-500 text-red-500 bg-red-500/10"
          )}>
            <Clock className="w-4 h-4" />
            <span className="text-xl font-bold tabular-nums">{formatTime(timeLeft)}</span>
          </div>
          <button
            type="button"
            onClick={() => setVoiceEnabled((v) => {
              const next = !v;
              if (next) spokenRef.current = '';
              if (!next && typeof window !== 'undefined' && 'speechSynthesis' in window) {
                window.speechSynthesis.cancel();
              }
              return next;
            })}
            disabled={!voiceSupported}
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-md border text-xs transition-colors",
              voiceEnabled
                ? "border-[#00ff41]/60 text-[#00ff41] bg-[#00ff41]/10"
                : "border-white/10 text-white/70 bg-white/5",
              !voiceSupported && "opacity-40 cursor-not-allowed"
            )}
          >
            {voiceEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
            <span>{voiceSupported ? (voiceEnabled ? "Audio On" : "Audio Off") : "No TTS"}</span>
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="w-full max-w-5xl flex-1 flex flex-col md:flex-row gap-6 z-20 overflow-hidden">
        {/* Left: Chat/Terminal */}
        <div className="flex-1 flex flex-col bg-black/40 border border-[#00ff41]/20 rounded-xl terminal-glow overflow-hidden">
          <div 
            ref={scrollRef}
            className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-thin scrollbar-thumb-[#00ff41]/20"
          >
            {!gameStarted ? (
              <div className="h-full flex flex-col items-center justify-center text-center space-y-6">
                <AlertTriangle className="w-16 h-16 text-yellow-500 animate-pulse" />
                <div className="space-y-2">
                  <h2 className="text-2xl font-bold text-[#00ff41]">CRITICAL SYSTEM FAILURE</h2>
                  <p className="text-sm opacity-70 max-w-md">
                    The ship's core systems are destabilizing. You must interface with AURA to identify and resolve 3 critical errors before hull collapse.
                  </p>
                </div>
                <button 
                  onClick={startGame}
                  className="px-8 py-3 bg-[#00ff41] text-black font-bold rounded-md hover:bg-[#00ff41]/80 transition-colors active:scale-95"
                >
                  INITIALIZE EMERGENCY LINK
                </button>
              </div>
            ) : (
              <>
                <AnimatePresence mode="popLayout">
                  {messages.map((msg, i) => (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={cn(
                        "flex flex-col max-w-[85%]",
                        msg.role === 'user' ? "ml-auto items-end" : "items-start"
                      )}
                    >
                      <span className="text-[10px] uppercase opacity-40 mb-1">
                        {msg.role === 'user' ? 'Operator' : 'AURA'}
                      </span>
                      <div className={cn(
                        "p-4 rounded-lg text-sm leading-relaxed",
                        msg.role === 'user' 
                          ? "bg-[#00ff41]/10 border border-[#00ff41]/30 text-[#00ff41]" 
                          : "bg-white/5 border border-white/10 text-white/90"
                      )}>
                        <div className="markdown-body">
                          <Markdown>
                            {msg.role === 'model' 
                              ? msg.text.replace(/```json\n([\s\S]*?)\n```/g, '').trim() 
                              : msg.text}
                          </Markdown>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </AnimatePresence>
                {loading && (
                  <div className="flex items-center gap-2 text-[#00ff41] opacity-50 italic text-xs">
                    <div className="w-1 h-1 bg-[#00ff41] rounded-full animate-bounce" />
                    <div className="w-1 h-1 bg-[#00ff41] rounded-full animate-bounce [animation-delay:0.2s]" />
                    <div className="w-1 h-1 bg-[#00ff41] rounded-full animate-bounce [animation-delay:0.4s]" />
                    <span>AURA IS PROCESSING...</span>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Input Area */}
          <form 
            onSubmit={handleSend}
            className="p-4 border-t border-[#00ff41]/20 bg-black/60 flex items-center gap-3"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={gameActive ? "Enter command..." : "System offline..."}
              disabled={!gameActive || loading}
              className="flex-1 bg-transparent border-none outline-none text-[#00ff41] placeholder-[#00ff41]/30 text-sm"
              autoFocus
            />
            <button 
              type="submit"
              disabled={!gameActive || loading || !input.trim()}
              className="p-2 text-[#00ff41] hover:bg-[#00ff41]/10 rounded-md disabled:opacity-30 transition-all"
            >
              <Send className="w-5 h-5" />
            </button>
          </form>
        </div>

        {/* Right: Sidebar Info */}
        <aside className="w-full md:w-80 flex flex-col gap-6 overflow-y-auto scrollbar-none">
          {/* Dashboard GUI Panel */}
          <AnimatePresence>
            {currentSystemData && (
              <motion.div 
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                className="p-6 bg-[#00ff41]/5 border border-[#00ff41]/40 rounded-xl terminal-glow"
              >
                <h3 className="text-xs font-bold uppercase tracking-widest mb-4 flex items-center gap-2 text-[#00ff41]">
                  <Zap className="w-3 h-3" /> System Interface: {currentSystemData.system || 'ACTIVE'}
                </h3>
                <div className="space-y-4 font-mono">
                  {Object.entries(currentSystemData.parameters || currentSystemData).map(([key, value]: [string, any]) => {
                    if (key === 'system' || key === 'status' || key === 'parameters') return null;
                    
                    const renderData = (data: any): React.ReactNode => {
                      if (data === null || data === undefined) return <span className="text-gray-500 italic">NULL</span>;
                      
                      if (typeof data === 'object' && !Array.isArray(data)) {
                        return (
                          <div className="grid grid-cols-1 gap-1.5 mt-1">
                            {Object.entries(data).map(([k, v]) => (
                              <div key={k} className="flex justify-between items-start bg-black/40 p-2 rounded border border-[#00ff41]/10 gap-2">
                                <span className="opacity-70 text-[10px] uppercase tracking-tighter whitespace-nowrap">{k}</span>
                                <div className="text-right">
                                  {typeof v === 'object' ? renderData(v) : (
                                    <span className={cn(
                                      "font-bold text-[11px] break-all",
                                      typeof v === 'number' ? "text-blue-400" : "text-[#00ff41]"
                                    )}>{String(v)}</span>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        );
                      }
                      
                      if (Array.isArray(data)) {
                        return (
                          <div className="space-y-1 mt-1">
                            {data.map((item, idx) => (
                              <div key={idx} className="bg-black/40 p-1.5 rounded border border-[#00ff41]/10 text-[11px]">
                                {typeof item === 'object' ? renderData(item) : String(item)}
                              </div>
                            ))}
                          </div>
                        );
                      }

                      return (
                        <span className={cn(
                          "font-bold break-all",
                          typeof data === 'number' ? "text-blue-400" : "text-[#00ff41]"
                        )}>{String(data)}</span>
                      );
                    };

                    return (
                      <div key={key} className="border-l-2 border-[#00ff41]/20 pl-3 py-1">
                        <div className="text-[10px] uppercase opacity-50 mb-1">{key}</div>
                        <div className="text-xs">
                          {typeof value === 'object' ? renderData(value) : (
                            <div className="bg-black/40 p-2 rounded border border-[#00ff41]/10 flex justify-between items-center">
                              {renderData(value)}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  <div className="pt-4 border-t border-[#00ff41]/20">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] uppercase opacity-50">Status</span>
                      <span className={cn(
                        "text-[10px] px-2 py-0.5 rounded border",
                        currentSystemData.status === 'RESOLVED' || currentSystemData.status === 'OK'
                          ? "bg-emerald-500/20 text-emerald-500 border-emerald-500/30"
                          : "bg-red-500/20 text-red-500 border-red-500/30 animate-pulse"
                      )}>
                        {currentSystemData.status || 'UNKNOWN'}
                      </span>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Status Panel */}
          <div className="p-6 bg-black/40 border border-[#00ff41]/20 rounded-xl terminal-glow">
            <h3 className="text-xs font-bold uppercase tracking-widest mb-4 flex items-center gap-2">
              <Shield className="w-3 h-3" /> System Diagnostics
            </h3>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Zap className="w-4 h-4 text-yellow-500" />
                  <span className="text-xs">Power Grid</span>
                </div>
                <span className="text-[10px] px-2 py-0.5 rounded bg-red-500/20 text-red-500 border border-red-500/30">UNSTABLE</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Navigation className="w-4 h-4 text-blue-500" />
                  <span className="text-xs">Navigation</span>
                </div>
                <span className="text-[10px] px-2 py-0.5 rounded bg-red-500/20 text-red-500 border border-red-500/30">CORRUPT</span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Shield className="w-4 h-4 text-emerald-500" />
                  <span className="text-xs">Life Support</span>
                </div>
                <span className="text-[10px] px-2 py-0.5 rounded bg-red-500/20 text-red-500 border border-red-500/30">LEAKING</span>
              </div>
            </div>
          </div>

          {/* Quick Commands */}
          <div className="p-6 bg-black/40 border border-[#00ff41]/20 rounded-xl terminal-glow flex-1">
            <h3 className="text-xs font-bold uppercase tracking-widest mb-4">Protocol Hints</h3>
            <ul className="text-[11px] space-y-3 opacity-70">
              <li className="flex gap-2">
                <span className="text-[#00ff41] font-bold">01</span>
                <span>Ask AURA to "List systems" to see current status.</span>
              </li>
              <li className="flex gap-2">
                <span className="text-[#00ff41] font-bold">02</span>
                <span>Use "Switch to [System]" to inspect data.</span>
              </li>
              <li className="flex gap-2">
                <span className="text-[#00ff41] font-bold">03</span>
                <span>Modify JSON parameters to fix errors.</span>
              </li>
              <li className="flex gap-2">
                <span className="text-[#00ff41] font-bold">04</span>
                <span>Time is your enemy. Be precise.</span>
              </li>
            </ul>
          </div>
        </aside>
      </main>

      {/* Game Over Overlay */}
      <AnimatePresence>
        {gameOver && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-black/90 flex flex-col items-center justify-center p-6 text-center"
          >
            <div className="max-w-md space-y-6">
              {victory ? (
                <>
                  <div className="w-20 h-20 bg-emerald-500/20 rounded-full flex items-center justify-center mx-auto border border-emerald-500/40">
                    <Shield className="w-10 h-10 text-emerald-500" />
                  </div>
                  <h2 className="text-4xl font-bold text-emerald-500 tracking-tighter">MISSION SUCCESS</h2>
                  <p className="opacity-70">Systems stabilized. Hull integrity secured. You saved the ship in {GAME_TIME_LIMIT - timeLeft} seconds.</p>
                </>
              ) : (
                <>
                  <div className="w-20 h-20 bg-red-500/20 rounded-full flex items-center justify-center mx-auto border border-red-500/40">
                    <AlertTriangle className="w-10 h-10 text-red-500" />
                  </div>
                  <h2 className="text-4xl font-bold text-red-500 tracking-tighter">MISSION FAILED</h2>
                  <p className="opacity-70">Hull integrity zero. The ship has been lost to the void. Time expired.</p>
                </>
              )}
              
              <button 
                onClick={startGame}
                className="flex items-center gap-2 px-8 py-3 bg-white text-black font-bold rounded-md hover:bg-white/80 transition-all mx-auto"
              >
                <RotateCcw className="w-4 h-4" /> REBOOT SYSTEM
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Footer */}
      <footer className="w-full max-w-5xl mt-6 flex justify-between items-center text-[10px] uppercase tracking-widest opacity-30 z-20">
        <span>Neural Link: Stable</span>
        <span>Sector: 7G-Alpha</span>
        <span>© 2026 AURA Intelligence Systems</span>
      </footer>
    </div>
  );
}
