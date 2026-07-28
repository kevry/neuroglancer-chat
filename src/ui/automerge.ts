/**
 * @license
 * Copyright 2026 Google Inc.
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

import "#src/ui/automerge.css";

import type { SidePanelManager } from "#src/ui/side_panel.js";
import { SidePanel } from "#src/ui/side_panel.js";
import {
  TrackableSidePanelLocation,
  DEFAULT_SIDE_PANEL_LOCATION,
} from "#src/ui/side_panel_location.js";
import { emptyToUndefined } from "#src/util/json.js";
import type { Trackable } from "#src/util/trackable.js";
import type { Viewer } from "#src/viewer.js";

const DEFAULT_AUTOMERGE_PANEL_LOCATION = {
  ...DEFAULT_SIDE_PANEL_LOCATION,
  side: "right" as const,
  row: 2, // chatbot is row 1, so this stacks nicely
};

const CHATBOT_SERVER = "ng.leelab.hms.harvard.edu";
const serverIp = CHATBOT_SERVER;
const AMP_BACKEND_URL = `http://${serverIp}`;

export interface AMPCandidate {
  id: string;
  target_segment_id: string;
  confidence: number;
  coordinate: [number, number, number];
  description: string;
}

export class AutomergePanelState implements Trackable {
  location = new TrackableSidePanelLocation(DEFAULT_AUTOMERGE_PANEL_LOCATION);

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

export class AutomergePanel extends SidePanel {
  private container = document.createElement("div");
  private inputCard = document.createElement("div");
  private progressCard = document.createElement("div");
  private resultsCard = document.createElement("div");
  private errorCard = document.createElement("div");

  private jobId: string | null = null;
  private pollingIntervalId: any = null;
  private activeCandidateId: string | null = null;
  private baseSegmentId: string | null = null;

  constructor(
    sidePanelManager: SidePanelManager,
    public state: AutomergePanelState,
    public viewer: Viewer,
  ) {
    super(sidePanelManager, state.location);
    console.log("AutomergePanel instance created");

    const { titleBar } = this.addTitleBar({ title: "Auto Merge" });

    // Reset button on the top right of the panel titlebar
    const resetBtn = document.createElement("button");
    resetBtn.classList.add("neuroglancer-automerge-reset-btn");
    resetBtn.title = "Start new auto merge task";
    resetBtn.innerHTML = "New Task";
    resetBtn.addEventListener("click", () => {
      this.resetUI();
    });
    titleBar.appendChild(resetBtn);

    const body = document.createElement("div");
    body.classList.add("neuroglancer-automerge-panel");

    this.container.classList.add("neuroglancer-automerge-container");
    body.appendChild(this.container);

    // 1. Error Card (Alert)
    this.errorCard.classList.add("neuroglancer-automerge-error-card");
    this.errorCard.style.display = "none";
    this.container.appendChild(this.errorCard);

    // 2. Input Card (Target root_id configuration)
    this.inputCard.classList.add("neuroglancer-automerge-card");
    this.inputCard.innerHTML = `
      <h3>Run Auto Merge (AMP)</h3>
      <p>Automated twigs proofreader using GPU classifiers to predict candidates for merge.</p>
      <div class="neuroglancer-automerge-field">
        <label for="amp-root-id-input">Target Segment (Root ID)</label>
        <div class="neuroglancer-automerge-input-wrapper">
          <input type="text" id="amp-root-id-input" class="neuroglancer-automerge-input" placeholder="e.g. 720575940626359560">
        </div>
        <div id="amp-prefill-btn" class="neuroglancer-automerge-prefill-hint" style="display: none;">
          ⚡ Use selected: <span id="amp-prefill-val"></span>
        </div>
      </div>
      <button id="amp-start-btn" class="neuroglancer-automerge-btn" style="width: 100%;">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-right: 4px;"><path d="M8 5v14l11-7z"/></svg>
        Run AMP Classifier
      </button>
    `;
    this.container.appendChild(this.inputCard);

    // 3. Progress Card
    this.progressCard.classList.add("neuroglancer-automerge-card");
    this.progressCard.style.display = "none";
    this.progressCard.innerHTML = `
      <h3>Processing Neuron</h3>
      <div class="neuroglancer-automerge-progress-container">
        <div class="neuroglancer-automerge-progress-header">
          <span class="neuroglancer-automerge-progress-label">Task Progress</span>
          <span id="amp-progress-percent" class="neuroglancer-automerge-progress-percent">0%</span>
        </div>
        <div class="neuroglancer-automerge-progress-bar-bg">
          <div id="amp-progress-bar-fill" class="neuroglancer-automerge-progress-bar-fill"></div>
        </div>
        <div id="amp-progress-status" class="neuroglancer-automerge-progress-status">Initializing...</div>
        <button id="amp-cancel-btn" class="neuroglancer-automerge-btn secondary" style="width: 100%; margin-top: 8px;">
          Cancel Polling
        </button>
      </div>
    `;
    this.container.appendChild(this.progressCard);

    // 4. Results Card
    this.resultsCard.classList.add("neuroglancer-automerge-card");
    this.resultsCard.style.display = "none";
    this.container.appendChild(this.resultsCard);

    this.addBody(body);

    // Consolidated event blocking: prevents parent SidePanel from dragging when clicking/scrolling within the body
    const stopPropagation = (e: Event) => e.stopPropagation();
    body.addEventListener("mousedown", stopPropagation);
    body.addEventListener("dragstart", stopPropagation);

    // Set up listeners
    this.setupEventListeners();

    // Register active layer selection observer for prefilling
    this.registerDisposer(
      this.viewer.layerSelectedValues.changed.add(() => {
        this.updatePrefillHint();
      }),
    );
    this.updatePrefillHint();

    this.registerDisposer(() => {
      this.stopPolling();
    });
  }

  private setupEventListeners() {
    const startBtn = this.inputCard.querySelector("#amp-start-btn");
    const rootIdInput = this.inputCard.querySelector("#amp-root-id-input") as HTMLInputElement;
    const prefillBtn = this.inputCard.querySelector("#amp-prefill-btn");
    const cancelBtn = this.progressCard.querySelector("#amp-cancel-btn");

    if (startBtn && rootIdInput) {
      startBtn.addEventListener("click", () => {
        const rootId = rootIdInput.value.trim();
        if (rootId) {
          this.startAMPTask(rootId);
        } else {
          this.showError("Please enter a valid Target Segment ID.");
        }
      });

      rootIdInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          const rootId = rootIdInput.value.trim();
          if (rootId) this.startAMPTask(rootId);
          e.preventDefault();
        }
        e.stopPropagation();
      });
    }

    if (prefillBtn) {
      prefillBtn.addEventListener("click", () => {
        const prefillVal = this.getHoveredSegmentId();
        if (prefillVal && rootIdInput) {
          rootIdInput.value = prefillVal;
        }
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => {
        this.resetUI();
      });
    }
  }

  private updatePrefillHint() {
    const prefillVal = this.getHoveredSegmentId();
    const prefillBtn = this.inputCard.querySelector("#amp-prefill-btn") as HTMLElement;
    const prefillSpan = this.inputCard.querySelector("#amp-prefill-val") as HTMLElement;

    if (prefillVal && prefillBtn && prefillSpan) {
      prefillSpan.textContent = prefillVal;
      prefillBtn.style.display = "inline-flex";
    } else if (prefillBtn) {
      prefillBtn.style.display = "none";
    }
  }

  private getHoveredSegmentId(): string {
    const values = this.viewer.layerSelectedValues;
    for (const layer of this.viewer.layerManager.managedLayers) {
      const userLayer = layer.layer;
      if (userLayer && (userLayer.constructor as any).type === "segmentation") {
        const state = values.get(userLayer);
        if (state && state.value !== undefined) {
          return state.value.toString();
        }
      }
    }
    // Fallback: look for visible segments
    for (const layer of this.viewer.layerManager.managedLayers) {
      const userLayer = layer.layer;
      if (userLayer && (userLayer.constructor as any).type === "segmentation") {
        const displayState = (userLayer as any).displayState;
        if (displayState && displayState.segmentationGroupState) {
          const segGroupState = displayState.segmentationGroupState.value;
          if (segGroupState && segGroupState.visibleSegments) {
            const visible = Array.from(segGroupState.visibleSegments);
            if (visible.length > 0) {
              return visible[0].toString();
            }
          }
        }
      }
    }
    return "";
  }

  private getSegmentationSource(): string {
    for (const layer of this.viewer.layerManager.managedLayers) {
      const userLayer = layer.layer;
      if (userLayer && (userLayer.constructor as any).type === "segmentation") {
        if (userLayer.dataSources && userLayer.dataSources.length > 0) {
          return userLayer.dataSources[0].spec.url;
        }
      }
      const state = layer.toJSON();
      if (state?.type === "segmentation") {
        return (state as any).source || "";
      }
    }
    return "";
  }

  private getDimensions(): any {
    const dimensions: any = {};
    const space = this.viewer.navigationState.coordinateSpace.value;
    if (space && space.names && space.scales) {
      for (let i = 0; i < space.names.length; i++) {
        const name = space.names[i];
        const scale = space.scales[i];
        dimensions[name] = [scale, "m"];
      }
    }
    return dimensions;
  }

  private async startAMPTask(segmentId: string) {
    this.hideError();
    const segmentationSource = this.getSegmentationSource();
    const dimensions = this.getDimensions();

    const payload = {
      segment_id: segmentId,
      segmentation_source: segmentationSource || undefined,
      dimensions: Object.keys(dimensions).length > 0 ? dimensions : undefined,
    };

    try {
      this.inputCard.style.display = "none";
      this.progressCard.style.display = "block";
      this.updateProgress(0, "Connecting to AMP backend...");

      const response = await fetch(`${AMP_BACKEND_URL}/api/v1/amp/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || "Failed to start AMP task");
      }

      const data = await response.json();
      this.jobId = data.job_id;
      console.log(`AMP task queued with job_id: ${this.jobId}`);

      this.startPolling();
    } catch (e: any) {
      this.showError(`Error starting task: ${e.message}`);
      this.resetUI();
    }
  }

  private startPolling() {
    this.stopPolling();
    this.pollingIntervalId = setInterval(() => {
      this.pollStatus();
    }, 1500);
  }

  private stopPolling() {
    if (this.pollingIntervalId !== null) {
      clearInterval(this.pollingIntervalId);
      this.pollingIntervalId = null;
    }
  }

  private async pollStatus() {
    if (!this.jobId) return;

    try {
      const response = await fetch(`${AMP_BACKEND_URL}/api/v1/amp/status/${this.jobId}`);
      if (!response.ok) {
        throw new Error("Failed to get task status");
      }

      const data = await response.json();
      if (data.status === "running") {
        this.updateProgress(data.progress || 0.0, data.message || "Running autoproofreading...");
      } else if (data.status === "completed") {
        this.stopPolling();
        this.renderCandidates(data.base_segment_id, data.candidates || []);
      } else if (data.status === "failed") {
        this.stopPolling();
        this.showError(`Task failed: ${data.error || "Unknown error"}`);
        this.resetUI();
      }
    } catch (e: any) {
      console.warn("Polling error:", e);
    }
  }

  private updateProgress(progress: number, message: string) {
    const percentSpan = this.progressCard.querySelector("#amp-progress-percent");
    const barFill = this.progressCard.querySelector("#amp-progress-bar-fill") as HTMLElement;
    const statusDiv = this.progressCard.querySelector("#amp-progress-status");

    const roundedProgress = Math.round(progress);
    if (percentSpan) percentSpan.textContent = `${roundedProgress}%`;
    if (barFill) barFill.style.width = `${roundedProgress}%`;
    if (statusDiv) statusDiv.textContent = message;
  }

  private renderCandidates(baseSegmentId: string, candidates: AMPCandidate[]) {
    this.baseSegmentId = baseSegmentId;
    this.progressCard.style.display = "none";
    this.resultsCard.style.display = "block";
    this.activeCandidateId = null;

    let html = `
      <h3>Merge Candidates</h3>
      <p style="margin-bottom: 12px;">Found <strong>${candidates.length}</strong> candidates for segment <strong>${baseSegmentId}</strong>.</p>
    `;

    if (candidates.length === 0) {
      html += `
        <div class="neuroglancer-automerge-empty">
          <div class="neuroglancer-automerge-empty-icon">🎉</div>
          <div class="neuroglancer-automerge-empty-text">No twig merges detected.<br>Neuron is fully proofread!</div>
        </div>
      `;
    } else {
      html += `<div class="neuroglancer-automerge-candidates">`;
      for (const cand of candidates) {
        const confPct = Math.round(cand.confidence * 100);
        const confClass = confPct >= 75 ? "high" : "medium";

        html += `
          <div class="neuroglancer-automerge-candidate-card" data-id="${cand.id}">
            <div class="neuroglancer-automerge-candidate-header">
              <span class="neuroglancer-automerge-candidate-title">Merge Option ${cand.id.split("_")[1] || cand.id}</span>
              <span class="neuroglancer-automerge-confidence ${confClass}">${confPct}% Match</span>
            </div>
            <div class="neuroglancer-automerge-candidate-body">
              <div>Target Segment ID:</div>
              <span class="neuroglancer-automerge-candidate-id">${cand.target_segment_id}</span>
              <div class="neuroglancer-automerge-candidate-coords">
                <svg viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
                <span>Coords: [${cand.coordinate.map(c => Math.round(c)).join(", ")}]</span>
              </div>
              <div style="display: flex; justify-content: flex-end;">
                <button class="neuroglancer-automerge-feedback-btn" data-id="${cand.id}">
                  False Positive
                </button>
              </div>
            </div>
          </div>
        `;
      }
      html += `</div>`;
    }

    this.resultsCard.innerHTML = html;

    // Set up click handlers on candidate cards
    const cards = this.resultsCard.querySelectorAll(".neuroglancer-automerge-candidate-card");
    cards.forEach((card) => {
      card.addEventListener("click", () => {
        const cardId = card.getAttribute("data-id");
        const cand = candidates.find((c) => c.id === cardId);
        if (cand) {
          // Highlight active card
          cards.forEach((c) => c.classList.remove("active"));
          card.classList.add("active");
          this.activeCandidateId = cand.id;

          // Teleport & select segment
          this.teleportToCandidate(cand);
        }
      });
    });

    // Set up click handlers on feedback buttons
    const feedbackBtns = this.resultsCard.querySelectorAll(".neuroglancer-automerge-feedback-btn");
    feedbackBtns.forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation(); // prevent card selection / teleportation
        const cardId = btn.getAttribute("data-id");
        const cand = candidates.find((c) => c.id === cardId);
        if (cand && !btn.classList.contains("submitted")) {
          btn.classList.add("submitted");
          btn.textContent = "Reporting...";
          try {
            await this.submitFalsePositiveFeedback(cand);
            btn.textContent = "Reported";
          } catch (err: any) {
            btn.classList.remove("submitted");
            btn.textContent = "False Positive";
            console.error("Feedback submit error:", err);
            this.showError(`Failed to submit feedback: ${err.message}`);
          }
        }
      });
    });
  }

  private teleportToCandidate(cand: AMPCandidate) {
    // 1. Update viewer position (teleport coordinates)
    const rank = this.viewer.coordinateSpace.value.rank;
    const newPos = new Float32Array(rank);
    newPos[0] = cand.coordinate[0];
    newPos[1] = cand.coordinate[1];
    newPos[2] = cand.coordinate[2];

    const currentPos = this.viewer.navigationState.position.value;
    if (currentPos) {
      for (let i = 3; i < currentPos.length; i++) {
        newPos[i] = currentPos[i];
      }
    }
    this.viewer.navigationState.position.value = newPos;
    console.log(`Teleported viewer to candidate coordinate: ${cand.coordinate}`);

    // 2. Automatically select and highlight target segment
    const targetSegId = BigInt(cand.target_segment_id);
    for (const layer of this.viewer.layerManager.managedLayers) {
      const userLayer = layer.layer;
      if (userLayer && (userLayer.constructor as any).type === "segmentation") {
        try {
          if (typeof (userLayer as any).selectSegment === "function") {
            (userLayer as any).selectSegment(targetSegId, true);
          }
          // Ensure it's marked visible
          const displayState = (userLayer as any).displayState;
          if (displayState && displayState.segmentationGroupState) {
            const groupState = displayState.segmentationGroupState.value;
            if (groupState && groupState.visibleSegments) {
              groupState.visibleSegments.set(targetSegId, true);
            }
          }
        } catch (e) {
          console.warn("Failed to highlight segment", e);
        }
      }
    }
  }

  private async submitFalsePositiveFeedback(cand: AMPCandidate) {
    const payload = {
      base_segment_id: this.baseSegmentId || "",
      target_segment_id: cand.target_segment_id,
      coordinate: cand.coordinate,
      confidence: cand.confidence,
      job_id: this.jobId || "",
    };

    const response = await fetch(`${AMP_BACKEND_URL}/api/v1/amp/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `HTTP ${response.status} Error`);
    }
  }

  private resetUI() {
    this.stopPolling();
    this.jobId = null;
    this.baseSegmentId = null;
    this.activeCandidateId = null;

    this.inputCard.style.display = "block";
    this.progressCard.style.display = "none";
    this.resultsCard.style.display = "none";

    // Clean inputs
    const rootIdInput = this.inputCard.querySelector("#amp-root-id-input") as HTMLInputElement;
    if (rootIdInput) rootIdInput.value = "";
    this.updatePrefillHint();
  }

  private showError(msg: string) {
    this.errorCard.textContent = msg;
    this.errorCard.style.display = "block";
    // Auto scroll to top to show error
    this.container.scrollTop = 0;
  }

  private hideError() {
    this.errorCard.style.display = "none";
  }
}
