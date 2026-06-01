/**
 * @license
 * Copyright 2024 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import "#src/ui/chatbot.css";

import DOMPurify from "dompurify";
import { marked } from "marked";
import type { Socket } from "socket.io-client";
import { io } from "socket.io-client";

import type { SidePanelManager } from "#src/ui/side_panel.js";
import { SidePanel } from "#src/ui/side_panel.js";
import {
  TrackableSidePanelLocation,
  DEFAULT_SIDE_PANEL_LOCATION,
} from "#src/ui/side_panel_location.js";
import { yoshiLogoData } from "#src/ui/yoshi_logo_data.js";
import { emptyToUndefined } from "#src/util/json.js";
import type { Trackable } from "#src/util/trackable.js";
import { calculatePanelViewportBounds } from "#src/util/viewer_resolution_stats.js";
import type { Viewer } from "#src/viewer.js";

const DEFAULT_CHATBOT_PANEL_LOCATION = {
  ...DEFAULT_SIDE_PANEL_LOCATION,
  side: "right" as const,
  row: 1,
};

const CHATBOT_SERVER = "10.117.28.249"; // Change this to your IP when needed
const CHATBOT_BACKEND_URL = `http://${CHATBOT_SERVER}`;

export interface ChatbotMessage {
  sender: string;
  text: string;
  thinking?: string;
  images?: string[];
}

export class ChatbotPanelState implements Trackable {
  location = new TrackableSidePanelLocation(DEFAULT_CHATBOT_PANEL_LOCATION);

  socket = io(CHATBOT_BACKEND_URL);
  messages: ChatbotMessage[] = [];
  isAuthenticated = false;

  get changed() {
    return this.location.changed;
  }
  restoreState(obj: unknown) {
    if (obj === undefined) return;
    this.location.restoreState(obj);
  }
  reset() {
    this.location.reset();
  }
  toJSON() {
    return emptyToUndefined(this.location.toJSON());
  }
}

export class ChatbotPanel extends SidePanel {
  messagesContainer = document.createElement("div");
  inputArea = document.createElement("div");
  inputBox = document.createElement("input");
  sendButton = document.createElement("button");
  introElement = document.createElement("div");
  authElement = document.createElement("div");
  private typingIndicator = document.createElement("div");
  private socket: Socket;

  private currentBotMessageElement: HTMLDivElement | null = null;
  private currentThinkingContainerElement: HTMLDivElement | null = null;
  private currentThinkingContentElement: HTMLDivElement | null = null;
  private currentTextContentElement: HTMLDivElement | null = null;
  private currentThinkingChevronElement: HTMLSpanElement | null = null;
  private currentThinkingTitleElement: HTMLSpanElement | null = null;

  private accumulatedThinking = "";
  private accumulatedContent = "";
  private isStreaming = false;

  constructor(
    sidePanelManager: SidePanelManager,
    public state: ChatbotPanelState,
    public viewer: Viewer,
  ) {
    super(sidePanelManager, state.location);
    console.log("ChatbotPanel instance created");
    const { titleBar } = this.addTitleBar({ title: "Yoshi" });

    const newChatButton = document.createElement("button");
    newChatButton.classList.add("neuroglancer-chatbot-new-chat");
    newChatButton.title = "Start new conversation";
    newChatButton.innerHTML = "New Chat";
    newChatButton.addEventListener("click", () => {
      this.state.messages = [];
      this.messagesContainer.innerHTML = "";
      this.messagesContainer.appendChild(this.introElement);
      this.messagesContainer.appendChild(this.typingIndicator);
      this.introElement.style.display = "flex";

      this.isStreaming = false;
      this.currentBotMessageElement = null;
      this.currentThinkingContainerElement = null;
      this.currentThinkingContentElement = null;
      this.currentTextContentElement = null;
      this.currentThinkingChevronElement = null;
      this.currentThinkingTitleElement = null;
      this.accumulatedThinking = "";
      this.accumulatedContent = "";

      this.socket.emit("clear_chat");
    });
    titleBar.appendChild(newChatButton);

    const body = document.createElement("div");
    body.classList.add("neuroglancer-chatbot-panel");

    this.messagesContainer.classList.add("neuroglancer-chatbot-messages");
    body.appendChild(this.messagesContainer);

    // Create Intro Message
    this.introElement.classList.add("neuroglancer-chatbot-intro");
    this.introElement.innerHTML = `
      <div class="intro-icon"><img src="${yoshiLogoData}" style="width: 90px; height: 50px;"/></div>
      <h1>Hi, I'm Yoshi</h1>
      <p>Ask me anything about the segmentation layer. I can help you query:</p>
      <div class="intro-capabilities">
        <span>Synapse Table</span>
        <span>SeaTable</span>
        <span>CaveClient</span>
      </div>
      <div class="intro-footer">Alpha Test v1.0</div>
    `;
    this.messagesContainer.appendChild(this.introElement);

    // Create Auth Message
    this.authElement.classList.add("neuroglancer-chatbot-auth");
    this.authElement.innerHTML = `
      <div class="auth-icon">🔒</div>
      <h1>Restricted Access</h1>
      <p>Please enter the secret code to access Yoshi.</p>
      <div class="auth-input-wrapper">
        <input type="password" class="neuroglancer-chatbot-auth-input" placeholder="Enter code...">
        <button class="neuroglancer-chatbot-auth-button">Unlock</button>
      </div>
      <div class="auth-error" style="display: none;">Invalid secret code. Please try again.</div>
    `;
    body.appendChild(this.authElement);

    const authInput = this.authElement.querySelector(
      ".neuroglancer-chatbot-auth-input",
    ) as HTMLInputElement;
    const authButton = this.authElement.querySelector(
      ".neuroglancer-chatbot-auth-button",
    ) as HTMLButtonElement;

    authButton.addEventListener("click", () => this.performAuth());
    authInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.performAuth();
    });

    // Handle dragging: only allow dragging from the title bar
    this.element.draggable = false;
    titleBar.addEventListener("mouseenter", () => {
      this.element.draggable = true;
    });
    titleBar.addEventListener("mouseleave", () => {
      this.element.draggable = false;
    });

    this.updateUIState();

    this.inputArea.classList.add("neuroglancer-chatbot-input-area");
    this.inputBox.type = "text";
    this.inputBox.placeholder = "Ask a question...";
    this.inputBox.classList.add("neuroglancer-chatbot-input");

    // Console log to verify state
    console.log("Chatbot UI updated with drag-handle logic");

    this.sendButton.innerHTML = `<svg viewBox="0 0 24 24"><path d="M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z"/></svg>`;
    this.sendButton.classList.add("neuroglancer-chatbot-send");

    this.inputArea.appendChild(this.inputBox);
    this.inputArea.appendChild(this.sendButton);
    body.appendChild(this.inputArea);

    // Create Typing Indicator
    this.typingIndicator.classList.add("typing-indicator");
    this.typingIndicator.innerHTML = `<span></span><span></span><span></span>`;
    this.messagesContainer.appendChild(this.typingIndicator);

    this.addBody(body);
    body.draggable = false;

    // Consolidated event blocking: prevents parent SidePanel from dragging
    // when interacting with ANY part of the chatbot body (messages, input, auth).
    const stopPropagation = (e: Event) => e.stopPropagation();
    body.addEventListener("mousedown", stopPropagation);
    body.addEventListener("dragstart", stopPropagation);

    this.socket = state.socket;

    const onConnect = () => {
      console.log("Chatbot connected to backend (event)");
    };

    const onDisconnect = (reason: string) => {
      console.warn(`Chatbot disconnected: ${reason}`);
    };

    const onChatChunk = (data: {
      type: "thinking" | "content";
      chunk: string;
    }) => {
      // 1. If we are not currently streaming, start a new streaming message element
      if (!this.isStreaming) {
        this.isStreaming = true;
        this.accumulatedThinking = "";
        this.accumulatedContent = "";
        this.setTyping(false); // Hide the typing indicator

        // Hide intro if still visible
        this.introElement.style.display = "none";

        // Create the message element structure
        const msg = document.createElement("div");
        msg.classList.add("neuroglancer-chatbot-message", "bot");

        // Create thinking container
        const thinkingContainer = document.createElement("div");
        thinkingContainer.classList.add(
          "neuroglancer-chatbot-thinking-container",
        );
        thinkingContainer.style.display = "none"; // Hide until we actually get a thinking chunk

        const thinkingHeader = document.createElement("div");
        thinkingHeader.classList.add("neuroglancer-chatbot-thinking-header");

        const thinkingIcon = document.createElement("span");
        thinkingIcon.classList.add("neuroglancer-chatbot-thinking-icon");
        thinkingIcon.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H7c0-2.76 2.24-5 5-5s5 2.24 5 5c0 1.04-.42 1.99-1.07 2.75z"/></svg>`;

        const thinkingTitle = document.createElement("span");
        thinkingTitle.classList.add("neuroglancer-chatbot-thinking-title");
        thinkingTitle.textContent = "Thinking Process...";

        const thinkingChevron = document.createElement("span");
        thinkingChevron.classList.add("neuroglancer-chatbot-thinking-chevron");
        thinkingChevron.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>`;

        thinkingHeader.appendChild(thinkingIcon);
        thinkingHeader.appendChild(thinkingTitle);
        thinkingHeader.appendChild(thinkingChevron);

        const thinkingContent = document.createElement("div");
        thinkingContent.classList.add("neuroglancer-chatbot-thinking-content");

        thinkingContainer.appendChild(thinkingHeader);
        thinkingContainer.appendChild(thinkingContent);

        // Setup click listener to toggle collapse state dynamically
        thinkingHeader.addEventListener("click", () => {
          const isHidden = thinkingContent.style.display === "none";
          if (isHidden) {
            thinkingContent.style.display = "block";
            thinkingChevron.style.transform = "rotate(0deg)";
          } else {
            thinkingContent.style.display = "none";
            thinkingChevron.style.transform = "rotate(-90deg)";
          }
        });

        // Create content text element
        const textEl = document.createElement("div");
        textEl.classList.add("neuroglancer-chatbot-text");

        msg.appendChild(thinkingContainer);
        msg.appendChild(textEl);

        this.messagesContainer.appendChild(msg);
        this.messagesContainer.appendChild(this.typingIndicator);
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;

        this.currentBotMessageElement = msg;
        this.currentThinkingContainerElement = thinkingContainer;
        this.currentThinkingContentElement = thinkingContent;
        this.currentTextContentElement = textEl;
        this.currentThinkingChevronElement = thinkingChevron;
        this.currentThinkingTitleElement = thinkingTitle;
      }

      // 2. Process chunk based on type
      if (data.type === "thinking") {
        if (
          this.currentThinkingContainerElement &&
          this.currentThinkingContainerElement.style.display === "none"
        ) {
          this.currentThinkingContainerElement.style.display = "block";
        }
        this.accumulatedThinking += data.chunk;
        if (this.currentThinkingContentElement) {
          this.currentThinkingContentElement.textContent =
            this.accumulatedThinking;
        }
      } else if (data.type === "content") {
        this.accumulatedContent += data.chunk;

        // Hide the typing indicator if it is shown
        this.setTyping(false);

        // If content starts, collapse the thinking block and change its title to "Thought process"
        if (
          this.currentThinkingTitleElement &&
          this.currentThinkingTitleElement.textContent === "Thinking Process..."
        ) {
          this.currentThinkingTitleElement.textContent = "Thought process";
          if (this.currentThinkingContainerElement) {
            this.currentThinkingContainerElement.classList.add("done");
          }
          if (
            this.currentThinkingContentElement &&
            this.currentThinkingChevronElement
          ) {
            this.currentThinkingContentElement.style.display = "none";
            this.currentThinkingChevronElement.style.transform =
              "rotate(-90deg)";
          }
        }

        if (this.currentTextContentElement) {
          const parsed = marked.parse(this.accumulatedContent);
          if (typeof parsed === "string") {
            this.currentTextContentElement.innerHTML =
              DOMPurify.sanitize(parsed);
          } else {
            Promise.resolve(parsed).then((p) => {
              if (this.currentTextContentElement) {
                this.currentTextContentElement.innerHTML =
                  DOMPurify.sanitize(p);
              }
            });
          }
        }
      }

      this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    };

    const onResponse = (json: any) => {
      if (json.update_jsonstate && json.jsonstate) {
        try {
          this.viewer.state.restoreState(json.jsonstate);
        } catch (err) {
          console.error("Failed to apply jsonstate update", err);
          this.addMessage(
            "Yoshi",
            `[Internal Error]: Failed to apply viewer state update.`,
          );
        }
      }
      this.setTyping(false); // Hide typing dots when response arrives

      const responseText = json.response || "";
      const thinkingText = json.thinking || "";

      if (this.isStreaming && this.currentBotMessageElement) {
        // Sync final content in case any chunks were missed
        this.accumulatedThinking = thinkingText;
        this.accumulatedContent = responseText;

        if (this.currentThinkingContentElement) {
          this.currentThinkingContentElement.textContent = thinkingText;
        }

        if (thinkingText) {
          if (this.currentThinkingContainerElement) {
            this.currentThinkingContainerElement.style.display = "block";
            this.currentThinkingContainerElement.classList.add("done");
          }
          if (this.currentThinkingTitleElement) {
            this.currentThinkingTitleElement.textContent = "Thought process";
          }
          if (
            this.currentThinkingContentElement &&
            this.currentThinkingChevronElement
          ) {
            this.currentThinkingContentElement.style.display = "none";
            this.currentThinkingChevronElement.style.transform =
              "rotate(-90deg)";
          }
        } else {
          if (this.currentThinkingContainerElement) {
            this.currentThinkingContainerElement.style.display = "none";
          }
        }

        if (this.currentTextContentElement) {
          const parsed = marked.parse(responseText);
          if (typeof parsed === "string") {
            this.currentTextContentElement.innerHTML =
              DOMPurify.sanitize(parsed);
          } else {
            Promise.resolve(parsed).then((p) => {
              if (this.currentTextContentElement) {
                this.currentTextContentElement.innerHTML =
                  DOMPurify.sanitize(p);
              }
            });
          }
        }

        // Save into message history
        this.state.messages.push({
          sender: "Yoshi",
          text: responseText,
          thinking: thinkingText || undefined,
        });
      } else {
        // Fallback for non-streaming or if we didn't receive any chunks
        this.addMessage(
          "Yoshi",
          responseText || JSON.stringify(json),
          undefined,
          false,
          thinkingText || undefined,
        );
      }

      // Reset streaming flags
      this.isStreaming = false;
      this.currentBotMessageElement = null;
      this.currentThinkingContainerElement = null;
      this.currentThinkingContentElement = null;
      this.currentTextContentElement = null;
      this.currentThinkingChevronElement = null;
      this.currentThinkingTitleElement = null;

      this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    };

    const onError = (err: any) => {
      this.addMessage(
        "Yoshi",
        `[Backend Error]: ${err.message || JSON.stringify(err)}`,
      );
    };

    this.socket.on("connect", onConnect);
    this.socket.on("disconnect", onDisconnect);
    this.socket.on("chat_chunk", onChatChunk);
    this.socket.on("chat_response", onResponse);
    this.socket.on("error", onError);

    if (this.socket.connected) {
      console.log("Chatbot reusing existing connection from state");
    }

    this.registerDisposer(() => {
      this.socket.off("connect", onConnect);
      this.socket.off("disconnect", onDisconnect);
      this.socket.off("chat_chunk", onChatChunk);
      this.socket.off("chat_response", onResponse);
      this.socket.off("error", onError);
    });

    // Restore existing messages
    if (this.state.messages.length > 0) {
      this.introElement.style.display = "none";
      for (const msg of this.state.messages) {
        this.addMessage(msg.sender, msg.text, msg.images, true, msg.thinking);
      }
    }

    const sendMessage = async () => {
      const text = this.inputBox.value.trim();
      if (!text) return;
      this.inputBox.value = "";

      // Capture screenshots
      const dataUrls: string[] = [];
      try {
        this.viewer.display.draw(); // Synchronously render to WebGL buffer
        const { individualRenderPanelViewports } = calculatePanelViewportBounds(
          this.viewer.display.panels,
        );
        const panels = individualRenderPanelViewports.slice(0, 4); // Up to 4 images
        for (const viewportBounds of panels) {
          const left = Math.max(0, Math.round(viewportBounds.left));
          const top = Math.max(0, Math.round(viewportBounds.top));
          const cropWidth = Math.round(
            viewportBounds.right - viewportBounds.left,
          );
          const cropHeight = Math.round(
            viewportBounds.bottom - viewportBounds.top,
          );

          if (cropWidth <= 0 || cropHeight <= 0) continue;

          // Prevent capturing beyond canvas bounds
          const canvasWidth = this.viewer.display.canvas.width;
          const canvasHeight = this.viewer.display.canvas.height;
          const safeWidth = Math.min(cropWidth, canvasWidth - left);
          const safeHeight = Math.min(cropHeight, canvasHeight - top);

          if (safeWidth <= 0 || safeHeight <= 0) continue;

          const canvas = document.createElement("canvas");
          canvas.width = safeWidth;
          canvas.height = safeHeight;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(
              this.viewer.display.canvas,
              left,
              top,
              safeWidth,
              safeHeight,
              0,
              0,
              safeWidth,
              safeHeight,
            );
            dataUrls.push(canvas.toDataURL("image/png"));
          }
        }
      } catch (e) {
        console.error("Failed to capture views", e);
      }

      this.addMessage("You", text, dataUrls);

      // Reset streaming state for the upcoming response
      this.isStreaming = false;
      this.currentBotMessageElement = null;
      this.currentThinkingContainerElement = null;
      this.currentThinkingContentElement = null;
      this.currentTextContentElement = null;
      this.currentThinkingChevronElement = null;
      this.currentThinkingTitleElement = null;
      this.accumulatedThinking = "";
      this.accumulatedContent = "";

      const metadata: any = {};
      try {
        const v = this.viewer;
        if (v.navigationState.position.value) {
          metadata.positionInVolume = Array.from(
            v.navigationState.position.value,
          );
        }
        if (v.navigationState.coordinateSpace.value.scales) {
          metadata.resolution = Array.from(
            v.navigationState.coordinateSpace.value.scales,
          );
        }
        if (v.mouseState.position) {
          metadata.cursorPosition = Array.from(v.mouseState.position);
        }

        const managedLayer = v.selectedLayer.layer;
        if (managedLayer) {
          metadata.activeLayer = {
            name: managedLayer.name,
            archived: managedLayer.archived,
            visible: managedLayer.visible,
          };
          const userLayer = managedLayer.layer;
          if (userLayer) {
            const layerType =
              (userLayer.constructor as any).type || (userLayer as any).type;
            metadata.activeLayer.type = layerType;
            if (userLayer.dataSources && userLayer.dataSources.length > 0) {
              metadata.activeLayer.cloudPath =
                userLayer.dataSources[0].spec.url;
            }
            // For segmentation layers, try to get visible segments
            if (
              (userLayer as any).displayState &&
              (userLayer as any).displayState.segmentationGroupState
            ) {
              const segGroupState = (userLayer as any).displayState
                .segmentationGroupState.value;
              if (segGroupState && segGroupState.visibleSegments) {
                metadata.activeLayer.visibleSegments = Array.from(
                  segGroupState.visibleSegments,
                );
              }
            }
          }
        }
        // Include full viewer JSON state
        metadata.jsonstate = v.state.toJSON();
      } catch (e) {
        console.warn("Failed to gather metadata", e);
      }

      const payload = {
        prompt: text,
        images: dataUrls.map((data) => ({ type: "image/png", data })),
        metadata: metadata,
      };

      console.log("Right before the emit");

      const payloadString = JSON.stringify(payload, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      );
      console.log(
        `Emitting chat_message. Payload size: ${(payloadString.length / 1024).toFixed(2)} KB`,
      );

      this.setTyping(true); // Show typing dots
      this.socket.emit("chat_message", JSON.parse(payloadString));
    };

    this.sendButton.addEventListener("click", sendMessage);
    this.inputBox.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        sendMessage();
        e.preventDefault();
      }
      e.stopPropagation();
    });
  }

  addMessage(
    sender: string,
    text: string,
    images?: string[],
    skipSave = false,
    thinking?: string,
  ) {
    if (!skipSave) {
      this.state.messages.push({ sender, text, images, thinking });
    }
    // Hide intro on first message
    this.introElement.style.display = "none";

    const msg = document.createElement("div");
    msg.classList.add("neuroglancer-chatbot-message");
    msg.classList.add(sender === "Yoshi" ? "bot" : "user");

    if (sender === "Yoshi" && thinking) {
      const thinkingContainer = document.createElement("div");
      thinkingContainer.classList.add(
        "neuroglancer-chatbot-thinking-container",
        "done",
      );

      const thinkingHeader = document.createElement("div");
      thinkingHeader.classList.add("neuroglancer-chatbot-thinking-header");

      const thinkingIcon = document.createElement("span");
      thinkingIcon.classList.add("neuroglancer-chatbot-thinking-icon");
      thinkingIcon.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H7c0-2.76 2.24-5 5-5s5 2.24 5 5c0 1.04-.42 1.99-1.07 2.75z"/></svg>`;

      const thinkingTitle = document.createElement("span");
      thinkingTitle.classList.add("neuroglancer-chatbot-thinking-title");
      thinkingTitle.textContent = "Thought process";

      const thinkingChevron = document.createElement("span");
      thinkingChevron.classList.add("neuroglancer-chatbot-thinking-chevron");
      thinkingChevron.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg>`;
      thinkingChevron.style.transform = "rotate(-90deg)"; // collapsed by default

      thinkingHeader.appendChild(thinkingIcon);
      thinkingHeader.appendChild(thinkingTitle);
      thinkingHeader.appendChild(thinkingChevron);

      const thinkingContent = document.createElement("div");
      thinkingContent.classList.add("neuroglancer-chatbot-thinking-content");
      thinkingContent.style.display = "none";
      thinkingContent.textContent = thinking;

      thinkingContainer.appendChild(thinkingHeader);
      thinkingContainer.appendChild(thinkingContent);

      thinkingHeader.addEventListener("click", () => {
        const isHidden = thinkingContent.style.display === "none";
        if (isHidden) {
          thinkingContent.style.display = "block";
          thinkingChevron.style.transform = "rotate(0deg)";
        } else {
          thinkingContent.style.display = "none";
          thinkingChevron.style.transform = "rotate(-90deg)";
        }
      });

      msg.appendChild(thinkingContainer);
    }

    const senderEl = document.createElement("div");
    senderEl.classList.add("neuroglancer-chatbot-sender");
    senderEl.textContent = sender;

    const textEl = document.createElement("div");
    textEl.classList.add("neuroglancer-chatbot-text");

    if (sender === "Yoshi") {
      const parsed = marked.parse(text);
      if (typeof parsed === "string") {
        textEl.innerHTML = DOMPurify.sanitize(parsed);
      } else {
        Promise.resolve(parsed).then((p) => {
          textEl.innerHTML = DOMPurify.sanitize(p);
        });
      }
    } else {
      textEl.textContent = text;
    }

    // msg.appendChild(senderEl);
    msg.appendChild(textEl);

    // TODO: Implement images in chatbot later. This was meant for debugging
    // if (images && images.length > 0) {
    //   const imagesContainer = document.createElement("div");
    //   imagesContainer.classList.add("neuroglancer-chatbot-images");
    //   for (const dataUrl of images) {
    //     const imgEl = document.createElement("img");
    //     imgEl.src = dataUrl;
    //     imgEl.classList.add("neuroglancer-chatbot-image");
    //     imagesContainer.appendChild(imgEl);
    //   }
    //   msg.appendChild(imagesContainer);
    // }

    this.messagesContainer.appendChild(msg);

    // Ensure typing indicator stays at the bottom
    this.messagesContainer.appendChild(this.typingIndicator);

    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  private setTyping(isTyping: boolean) {
    this.typingIndicator.style.display = isTyping ? "flex" : "none";
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  private updateUIState() {
    if (this.state.isAuthenticated) {
      this.authElement.style.display = "none";
      this.messagesContainer.style.display = "flex";
      this.inputArea.style.display = "flex";
    } else {
      this.authElement.style.display = "flex";
      this.messagesContainer.style.display = "none";
      this.inputArea.style.display = "none";
      this.attemptAutoAuth();
    }
  }

  private async loadMetadata() {
    try {
      // Find the first segmentation layer to get the source
      let sourceUrl = "";
      for (const layer of this.viewer.layerManager.managedLayers) {
        const state = layer.toJSON();
        if (state?.type === "segmentation") {
          sourceUrl = (state as any).source;
          break;
        }
      }

      if (!sourceUrl) return;

      const response = await fetch(
        `${CHATBOT_BACKEND_URL}/api/segmentation_metadata?segmentation_source=${encodeURIComponent(sourceUrl)}`,
      );
      if (response.ok) {
        const data = await response.json();
        this.updateIntroUI(data.dataset_name, data.metadata);
      }
    } catch (e) {
      console.warn("Failed to load dataset metadata", e);
    }
  }

  private updateIntroUI(datasetName: string, metadata: any) {
    const capabilities: string[] = [];

    if (metadata.synapse_table?.source) {
      capabilities.push(
        `<span class="capability-tag" title="Source: ${metadata.synapse_table.source}">Synapse Table</span>`,
      );
    }
    if (metadata.seatable?.source) {
      capabilities.push(
        `<span class="capability-tag" title="Source: ${metadata.seatable.source}">SeaTable</span>`,
      );
    }
    if (metadata.caveclient?.source) {
      capabilities.push(
        `<span class="capability-tag" title="Source: ${metadata.caveclient.source}">CaveClient</span>`,
      );
    }

    this.introElement.innerHTML = `
      <div class="intro-content">
        <div class="intro-header">
        <div class="intro-icon"><img src="${yoshiLogoData}" style="width: 90px; height: 50px;"/></div>
          <h1>Hi, I'm Yoshi</h1>
          <p>Ask me anything about the segmentation in the <strong>${datasetName}</strong> dataset.</p>
          <p>I can help query the:</p>
        </div>
        <div class="intro-capabilities">
          <div class="capability-tags">
            ${capabilities.join("")}
          </div>
        </div>
        <div class="intro-footer">Alpha Test v1</div>
      </div>
    `;

    // // Add click listeners to tags to show source in an alert or similar
    // this.introElement.querySelectorAll('.capability-tag').forEach(tag => {
    //   tag.addEventListener('click', (e) => {
    //     const source = (e.target as HTMLElement).getAttribute('title');
    //   });
    // });
  }

  private async performAuth(email?: string, code?: string) {
    const payload: any = {};
    if (email) payload.email = email;
    if (code) payload.code = code;

    if (!email && !code) {
      const authInput = this.authElement.querySelector(
        ".neuroglancer-chatbot-auth-input",
      ) as HTMLInputElement;
      const inputCode = authInput.value.trim();
      if (!inputCode) return;
      payload.code = inputCode;
    }

    try {
      const response = await fetch(`${CHATBOT_BACKEND_URL}/api/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        this.state.isAuthenticated = true;
        this.updateUIState();
        this.loadMetadata(); // Load metadata after successful auth
      } else if (!email) {
        const authError = this.authElement.querySelector(
          ".auth-error",
        ) as HTMLElement;
        const authInput = this.authElement.querySelector(
          ".neuroglancer-chatbot-auth-input",
        ) as HTMLInputElement;
        authError.style.display = "block";
        authInput.value = "";
      }
    } catch (e) {
      console.error("Auth failed", e);
    }
  }

  private async asyncAttemptAutoAuth() {
    try {
      console.log("Chatbot: Scanning credentials for identity...");
      const cm = (this.viewer as any).credentialsManager;
      if (!cm) return;

      const providers = cm.providers;
      if (!providers) {
        console.log("Chatbot: No providers found in credentialsManager.");
        return;
      }

      for (const [key, provider] of providers.entries()) {
        console.log(`Chatbot: Inspecting provider "${key}"`, provider);
        const p = provider as any;

        // Try to find anything that looks like an email in the provider itself
        const candidates = [
          p.email,
          p.userId,
          p.userId_,
          p.username,
          p.identity,
        ];
        if (typeof key === "string" && key.includes("@")) candidates.push(key);

        // Also look into the "credentials" if they are already loaded
        if (p.credentials && p.credentials.credentials) {
          const c = p.credentials.credentials;
          candidates.push(c.email, c.userId, c.username, c.identity);
        }

        for (const candidate of candidates) {
          if (
            candidate &&
            typeof candidate === "string" &&
            candidate.includes("@")
          ) {
            console.log(`Chatbot: Found potential identity: ${candidate}`);
            await this.performAuth(candidate);
            if (this.state.isAuthenticated) return;
          }
        }
      }
    } catch (e) {
      console.warn("Auto-auth attempt failed", e);
    }
  }

  private attemptAutoAuth() {
    // Call it asynchronously so we don't block the UI
    this.asyncAttemptAutoAuth();
  }
}
