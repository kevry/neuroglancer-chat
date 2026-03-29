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

import { marked } from "marked";
import DOMPurify from "dompurify";

import { SidePanel } from "#src/ui/side_panel.js";
import type { SidePanelManager } from "#src/ui/side_panel.js";
import { TrackableSidePanelLocation, DEFAULT_SIDE_PANEL_LOCATION } from "#src/ui/side_panel_location.js";
import type { Trackable } from "#src/util/trackable.js";
import { emptyToUndefined } from "#src/util/json.js";
import type { Viewer } from "#src/viewer.js";
import { calculatePanelViewportBounds } from "#src/util/viewer_resolution_stats.js";

const DEFAULT_CHATBOT_PANEL_LOCATION = {
  ...DEFAULT_SIDE_PANEL_LOCATION,
  side: "right" as const,
  row: 1,
};

export class ChatbotPanelState implements Trackable {
  location = new TrackableSidePanelLocation(DEFAULT_CHATBOT_PANEL_LOCATION);
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

  constructor(
    sidePanelManager: SidePanelManager,
    public state: ChatbotPanelState,
    public viewer: Viewer,
  ) {
    super(sidePanelManager, state.location);
    this.addTitleBar({ title: "Yoshi" });

    const body = document.createElement("div");
    body.classList.add("neuroglancer-chatbot-panel");

    this.messagesContainer.classList.add("neuroglancer-chatbot-messages");
    body.appendChild(this.messagesContainer);

    this.inputArea.classList.add("neuroglancer-chatbot-input-area");
    this.inputBox.type = "text";
    this.inputBox.placeholder = "Ask a question...";
    this.inputBox.classList.add("neuroglancer-chatbot-input");

    this.sendButton.textContent = "Send";
    this.sendButton.classList.add("neuroglancer-chatbot-send");

    this.inputArea.appendChild(this.inputBox);
    this.inputArea.appendChild(this.sendButton);
    body.appendChild(this.inputArea);

    this.addBody(body);

    const sendMessage = async () => {
      const text = this.inputBox.value.trim();
      if (!text) return;
      this.inputBox.value = "";

      // Capture screenshots
      const dataUrls: string[] = [];
      try {
        this.viewer.display.draw(); // Synchronously render to WebGL buffer
        const { individualRenderPanelViewports } = calculatePanelViewportBounds(this.viewer.display.panels);
        const panels = individualRenderPanelViewports.slice(0, 4); // Up to 4 images
        for (const viewportBounds of panels) {
          const left = Math.max(0, Math.round(viewportBounds.left));
          const top = Math.max(0, Math.round(viewportBounds.top));
          const cropWidth = Math.round(viewportBounds.right - viewportBounds.left);
          const cropHeight = Math.round(viewportBounds.bottom - viewportBounds.top);
          
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
              safeHeight
            );
            dataUrls.push(canvas.toDataURL("image/png"));
          }
        }
      } catch (e) {
        console.error("Failed to capture views", e);
      }

      this.addMessage("User", text, dataUrls);

      // Send to Flask API
      try {
        const payload = {
          prompt: text,
          images: dataUrls.map(data => ({ type: "image/png", data }))
        };
        const response = await fetch("http://localhost:5000/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        });
        const json = await response.json();
        this.addMessage("Bot", json.response || JSON.stringify(json));
      } catch (e) {
        this.addMessage("Bot", `[API Error]: ${(e as Error).message}. (Did you start the Flask backend?)`);
      }
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

  addMessage(sender: string, text: string, images?: string[]) {
    const msg = document.createElement("div");
    msg.classList.add("neuroglancer-chatbot-message");
    msg.classList.add(sender === "Bot" ? "bot" : "user");

    const senderEl = document.createElement("div");
    senderEl.classList.add("neuroglancer-chatbot-sender");
    senderEl.textContent = sender;

    const textEl = document.createElement("div");
    textEl.classList.add("neuroglancer-chatbot-text");
    
    if (sender === "Bot") {
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

    msg.appendChild(senderEl);
    msg.appendChild(textEl);

    if (images && images.length > 0) {
      const imagesContainer = document.createElement("div");
      imagesContainer.classList.add("neuroglancer-chatbot-images");
      for (const dataUrl of images) {
        const imgEl = document.createElement("img");
        imgEl.src = dataUrl;
        imgEl.classList.add("neuroglancer-chatbot-image");
        imagesContainer.appendChild(imgEl);
      }
      msg.appendChild(imagesContainer);
    }

    this.messagesContainer.appendChild(msg);
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }
}
