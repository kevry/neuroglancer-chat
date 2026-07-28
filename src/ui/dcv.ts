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

import "#src/ui/dcv.css";

import { AnnotationType } from "#src/annotation/index.js";
import type { LocalAnnotationSource } from "#src/annotation/index.js";
import { makeLayer } from "#src/layer/index.js";
import type { SidePanelManager } from "#src/ui/side_panel.js";
import { SidePanel } from "#src/ui/side_panel.js";
import {
  TrackableSidePanelLocation,
  DEFAULT_SIDE_PANEL_LOCATION,
} from "#src/ui/side_panel_location.js";
import { emptyToUndefined } from "#src/util/json.js";
import type { Trackable } from "#src/util/trackable.js";
import type { Viewer } from "#src/viewer.js";

const DEFAULT_DCV_PANEL_LOCATION = {
  ...DEFAULT_SIDE_PANEL_LOCATION,
  side: "right" as const,
  row: 3, // stacks nicely below chatbot (row 1) and automerge (row 2)
};

const CHATBOT_SERVER = "ng.leelab.hms.harvard.edu";
const serverIp =
  window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? "localhost"
    : CHATBOT_SERVER;
const DCV_BACKEND_URL = `http://${serverIp}:5002`;

export class DCVPanelState implements Trackable {
  location = new TrackableSidePanelLocation(DEFAULT_DCV_PANEL_LOCATION);

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

export class DCVPanel extends SidePanel {
  private container = document.createElement("div");
  private inputCard = document.createElement("div");
  private progressCard = document.createElement("div");
  private resultsCard = document.createElement("div");
  private errorCard = document.createElement("div");

  private targetSegmentId: string | null = null;
  private pollingIntervalId: any = null;
  private activeCoordinateIndex: number | null = null;
  private loadedCoordinates: [number, number, number][] = [];

  constructor(
    sidePanelManager: SidePanelManager,
    public state: DCVPanelState,
    public viewer: Viewer,
  ) {
    super(sidePanelManager, state.location);
    console.log("DCVPanel instance created");

    const { titleBar } = this.addTitleBar({ title: "DCV Aggregator" });

    // Reset button on title bar
    const resetBtn = document.createElement("button");
    resetBtn.classList.add("neuroglancer-dcv-reset-btn");
    resetBtn.title = "Clear and start new DCV search";
    resetBtn.innerHTML = "New Task";
    resetBtn.addEventListener("click", () => {
      this.resetUI();
    });
    titleBar.appendChild(resetBtn);

    const body = document.createElement("div");
    body.classList.add("neuroglancer-dcv-panel");

    this.container.classList.add("neuroglancer-dcv-container");
    body.appendChild(this.container);

    // 1. Error Card
    this.errorCard.classList.add("neuroglancer-dcv-error-card");
    this.errorCard.style.display = "none";
    this.container.appendChild(this.errorCard);

    // 2. Input Configuration Card
    this.inputCard.classList.add("neuroglancer-dcv-card");
    this.inputCard.innerHTML = `
      <h3>Aggregate DCVs</h3>
      <p>Traverse the connectome neuron to aggregate Dense Core Vesicles (DCVs) associated with it.</p>
      
      <div class="neuroglancer-dcv-field">
        <label for="dcv-root-id-input">Target Segment (Root ID)</label>
        <div class="neuroglancer-dcv-input-wrapper">
          <input type="text" id="dcv-root-id-input" class="neuroglancer-dcv-input" placeholder="Enter Segment ID...">
        </div>
        <div id="dcv-prefill-btn" class="neuroglancer-dcv-prefill-hint" style="display: none;">
          ⚡ Use selected: <span id="dcv-prefill-val"></span>
        </div>
      </div>

      <div class="neuroglancer-dcv-field">
        <label for="dcv-format-select">Coordinate Format</label>
        <select id="dcv-format-select" class="neuroglancer-dcv-select">
          <option value="nm" selected>Scaled Nanometers (Viewport Match)</option>
          <option value="voxel">MIP 0 Voxel indices ([8, 8, 45] nm)</option>
        </select>
      </div>

      <button id="dcv-start-btn" class="neuroglancer-dcv-btn" style="width: 100%;">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" style="margin-right: 4px;"><path d="M8 5v14l11-7z"/></svg>
        Aggregate DCVs
      </button>
    `;
    this.container.appendChild(this.inputCard);

    // 3. Progress Card
    this.progressCard.classList.add("neuroglancer-dcv-card");
    this.progressCard.style.display = "none";
    this.progressCard.innerHTML = `
      <h3>Aggregating DCVs</h3>
      <div class="neuroglancer-dcv-progress-container">
        <div class="neuroglancer-dcv-progress-header">
          <span class="neuroglancer-dcv-progress-label">Status</span>
          <span id="dcv-progress-percent" class="neuroglancer-dcv-progress-status-value">Processing...</span>
        </div>
        <div class="neuroglancer-dcv-progress-bar-bg">
          <div id="dcv-progress-bar-fill" class="neuroglancer-dcv-progress-bar-fill"></div>
        </div>
        <div id="dcv-progress-status" class="neuroglancer-dcv-progress-status">Initializing traversal...</div>
        <button id="dcv-cancel-btn" class="neuroglancer-dcv-btn secondary" style="width: 100%; margin-top: 8px;">
          Cancel Polling
        </button>
      </div>
    `;
    this.container.appendChild(this.progressCard);

    // 4. Results Card
    this.resultsCard.classList.add("neuroglancer-dcv-card");
    this.resultsCard.style.display = "none";
    this.container.appendChild(this.resultsCard);

    this.addBody(body);

    const stopPropagation = (e: Event) => e.stopPropagation();
    body.addEventListener("mousedown", stopPropagation);
    body.addEventListener("dragstart", stopPropagation);

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
    const startBtn = this.inputCard.querySelector("#dcv-start-btn");
    const rootIdInput = this.inputCard.querySelector("#dcv-root-id-input") as HTMLInputElement;
    const prefillBtn = this.inputCard.querySelector("#dcv-prefill-btn");
    const cancelBtn = this.progressCard.querySelector("#dcv-cancel-btn");

    if (startBtn && rootIdInput) {
      startBtn.addEventListener("click", () => {
        const rootId = rootIdInput.value.trim();
        if (rootId) {
          this.triggerDCVAggregation(rootId);
        } else {
          this.showError("Please enter a valid Segment ID.");
        }
      });

      rootIdInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          const rootId = rootIdInput.value.trim();
          if (rootId) this.triggerDCVAggregation(rootId);
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
    const prefillBtn = this.inputCard.querySelector("#dcv-prefill-btn") as HTMLElement;
    const prefillSpan = this.inputCard.querySelector("#dcv-prefill-val") as HTMLElement;

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
    // Fallback visible segment
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

  private async triggerDCVAggregation(segmentId: string) {
    this.hideError();
    this.targetSegmentId = segmentId;
    const formatSelect = this.inputCard.querySelector("#dcv-format-select") as HTMLSelectElement;
    const format = formatSelect ? formatSelect.value : "nm";

    const dimensions = this.getDimensions();

    const params = new URLSearchParams();
    params.append("segment_id", segmentId);
    params.append("coordinate_format", format);

    if (format === "nm" && Object.keys(dimensions).length > 0) {
      params.append("dimensions", JSON.stringify(dimensions));
    }

    try {
      this.inputCard.style.display = "none";
      this.progressCard.style.display = "block";
      this.updateProgress(0, "Connecting to DCV aggregator...");

      const url = `${DCV_BACKEND_URL}/dcv?${params.toString()}`;
      const response = await fetch(url);

      if (response.status === 200) {
        // Cached coordinates returned immediately
        const data = await response.json();
        await this.loadDCVCoordinates(data.dcvs || []);
      } else if (response.status === 202) {
        // Traversal started, need to poll
        const data = await response.json();
        console.log(`DCV aggregation triggered for segment ${segmentId}, job_id: ${data.job_id}`);
        this.startPolling();
      } else {
        const errData = await response.json();
        throw new Error(errData.error || "Failed to trigger DCV aggregation");
      }
    } catch (e: any) {
      this.showError(`Error running DCV tool: ${e.message}`);
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
    if (!this.targetSegmentId) return;

    try {
      const response = await fetch(`${DCV_BACKEND_URL}/dcv/status?segment_id=${this.targetSegmentId}`);
      if (!response.ok) {
        throw new Error("Failed to get aggregation status");
      }

      const data = await response.json();
      if (data.status === "running") {
        // Parse percentage from status message if possible (e.g. "Traversing local cutouts: 45%")
        const match = data.progress ? data.progress.match(/(\d+)%/) : null;
        const percent = match ? parseInt(match[1]) : 0;
        this.updateProgress(percent, data.progress || "Running traversal...");
      } else if (data.status === "success") {
        this.stopPolling();
        // Traverse complete! Fetch the final list of coordinates.
        this.fetchFinalDCVCoords();
      } else if (data.status === "failed") {
        this.stopPolling();
        this.showError(`Aggregation failed: ${data.error || "Unknown error"}`);
        this.resetUI();
      }
    } catch (e: any) {
      console.warn("DCV Polling error:", e);
    }
  }

  private async fetchFinalDCVCoords() {
    if (!this.targetSegmentId) return;
    const formatSelect = this.inputCard.querySelector("#dcv-format-select") as HTMLSelectElement;
    const format = formatSelect ? formatSelect.value : "nm";
    const dimensions = this.getDimensions();

    const params = new URLSearchParams();
    params.append("segment_id", this.targetSegmentId);
    params.append("coordinate_format", format);
    if (format === "nm" && Object.keys(dimensions).length > 0) {
      params.append("dimensions", JSON.stringify(dimensions));
    }

    try {
      this.updateProgress(99, "Downloading DCV list...");
      const url = `${DCV_BACKEND_URL}/dcv?${params.toString()}`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error("Failed to download final coordinates");
      }

      const data = await response.json();
      await this.loadDCVCoordinates(data.dcvs || []);
    } catch (e: any) {
      this.showError(`Error fetching aggregated coordinates: ${e.message}`);
      this.resetUI();
    }
  }

  private updateProgress(percent: number, message: string) {
    const percentSpan = this.progressCard.querySelector("#dcv-progress-percent");
    const barFill = this.progressCard.querySelector("#dcv-progress-bar-fill") as HTMLElement;
    const statusDiv = this.progressCard.querySelector("#dcv-progress-status");

    if (percentSpan) percentSpan.textContent = percent > 0 ? `${percent}%` : "In Progress";
    if (barFill) barFill.style.width = `${percent}%`;
    if (statusDiv) statusDiv.textContent = message;
  }

  private async getOrCreateDCVLayerSource(): Promise<LocalAnnotationSource> {
    let dcvLayer = this.viewer.layerManager.getLayerByName("DCVs");
    if (!dcvLayer) {
      dcvLayer = makeLayer(this.viewer.layerSpecification, "DCVs", {
        type: "annotation",
        source: "local://dcvs",
      });
      this.viewer.layerSpecification.add(dcvLayer);
    }

    return new Promise((resolve) => {
      const check = () => {
        const userLayer = dcvLayer!.layer;
        if (userLayer && (userLayer as any).localAnnotations) {
          resolve((userLayer as any).localAnnotations);
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }

  private async loadDCVCoordinates(coords: [number, number, number][]) {
    this.progressCard.style.display = "none";
    this.resultsCard.style.display = "block";
    this.loadedCoordinates = coords;
    this.activeCoordinateIndex = null;

    let html = `
      <h3>DCV Results</h3>
      <p style="margin-bottom: 12px;">Aggregated <strong>${coords.length}</strong> DCVs for neuron <strong>${this.targetSegmentId}</strong>.</p>
    `;

    if (coords.length === 0) {
      html += `
        <div class="neuroglancer-dcv-empty">
          <div style="font-size:32px;">📭</div>
          <div>No DCVs associated with this neuron were found.</div>
        </div>
      `;
    } else {
      html += `
        <div style="margin-bottom: 12px; font-size:12px; color:#aaa; font-style:italic;">
          📍 Loaded all ${coords.length} coordinates into the <strong>DCVs</strong> annotation layer.
        </div>
        <div class="neuroglancer-dcv-list">
      `;
      // We will render up to 150 coordinates in the DOM list to prevent heavy rendering delays,
      // but all of them are plotted in 3D in the Neuroglancer viewer
      const limit = Math.min(coords.length, 150);
      for (let i = 0; i < limit; i++) {
        const coord = coords[i];
        html += `
          <div class="neuroglancer-dcv-coord-card" data-idx="${i}">
            <span class="neuroglancer-dcv-coord-title">DCV #${i + 1}</span>
            <span class="neuroglancer-dcv-coord-values">[${coord.map(c => Math.round(c)).join(", ")}]</span>
          </div>
        `;
      }
      if (coords.length > 150) {
        html += `
          <div style="text-align: center; font-size: 11px; color: #555; padding: 6px;">
            ... and ${coords.length - 150} more (all visible in viewport) ...
          </div>
        `;
      }
      html += `</div>`;
    }

    this.resultsCard.innerHTML = html;

    // Load points dynamically into the local annotation source with commit=false
    try {
      const localSource = await this.getOrCreateDCVLayerSource();
      localSource.clear();

      for (const coord of coords) {
        localSource.add({
          type: AnnotationType.POINT,
          point: new Float32Array(coord),
          properties: [],
        }, /*commit=*/false); // uncommitted to avoid URL/state bloat
      }
      console.log(`Loaded ${coords.length} point annotations into local source without committing.`);
    } catch (err) {
      console.error("Failed to load point annotations:", err);
    }

    // Set up click handlers on list cards
    const cards = this.resultsCard.querySelectorAll(".neuroglancer-dcv-coord-card");
    cards.forEach((card) => {
      card.addEventListener("click", () => {
        const idxAttr = card.getAttribute("data-idx");
        if (idxAttr === null) return;
        const idx = parseInt(idxAttr);
        const coord = this.loadedCoordinates[idx];
        if (coord) {
          cards.forEach((c) => c.classList.remove("active"));
          card.classList.add("active");
          this.activeCoordinateIndex = idx;

          this.teleportToCoordinate(coord);
        }
      });
    });
  }

  private teleportToCoordinate(coord: [number, number, number]) {
    const rank = this.viewer.coordinateSpace.value.rank;
    const newPos = new Float32Array(rank);
    newPos[0] = coord[0];
    newPos[1] = coord[1];
    newPos[2] = coord[2];

    const currentPos = this.viewer.navigationState.position.value;
    if (currentPos) {
      for (let i = 3; i < currentPos.length; i++) {
        newPos[i] = currentPos[i];
      }
    }
    this.viewer.navigationState.position.value = newPos;
    console.log(`Teleported viewer to DCV coordinate: ${coord}`);
  }

  private resetUI() {
    this.stopPolling();
    this.targetSegmentId = null;
    this.activeCoordinateIndex = null;
    this.loadedCoordinates = [];

    this.inputCard.style.display = "block";
    this.progressCard.style.display = "none";
    this.resultsCard.style.display = "none";

    const rootIdInput = this.inputCard.querySelector("#dcv-root-id-input") as HTMLInputElement;
    if (rootIdInput) rootIdInput.value = "";
    this.updatePrefillHint();
  }

  private showError(msg: string) {
    this.errorCard.textContent = msg;
    this.errorCard.style.display = "block";
    this.container.scrollTop = 0;
  }

  private hideError() {
    this.errorCard.style.display = "none";
  }
}
