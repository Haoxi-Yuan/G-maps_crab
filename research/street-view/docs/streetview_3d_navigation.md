# Google Street View: 3D Navigation & Modeling

---

## Leveraging 3D Data for Smart Navigation

Street View supports a unique 3D navigation mode known as **"click-to-go,"** which lets users click their mouse on a point in the scene and be transported to the image nearest to that point's 3D location. Users can also hover the cursor over the image and see a floating shape that shrinks in proportion to the depth and follows the underlying surface's normal geometry.

### Depth Map Creation

Enabling such a feature requires the creation of a **depth map** that stores the distance and orientation of every point in the scene. Key design decisions include:

- A **low-resolution depth map** is computed (due to very high imagery resolution) so it can be quickly loaded over the network.
- For 3D navigation, the depth map only encodes the scene's **dominant surfaces** (e.g., building facades and roads), while ignoring smaller entities such as cars and people.

### Depth Computation Methods

Depth is computed via two approaches depending on data availability:

#### 1. Laser Range Scans (New Vehicles)
Imagery from new Street View vehicles is accompanied by laser range scans, which accurately measure the depth of a vertical fan of points on the two sides and the front of the vehicle. The range data is aggregated and simplified by **robustly fitting it in a coarse mesh** that models the dominant scene surfaces *(see Figure 4)*.

#### 2. Optical Flow (Older Platforms)
For imagery from older capture platforms lacking laser range data, depth is recovered by computing **optical flow** between successive images of the street facade on both sides of the vehicle.

- The optical flow at a given point depends on the vehicle's motion and that point's depth.
- To recover only the dominant scene surfaces, a **piecewise planar global model** of the facade is fitted to the optical-flow data over a long sequence of images.
- This process recovers building facades and road geometry accurately and robustly.
- The optimized depth estimation algorithm runs at about **50 frames per second** on a contemporary desktop *(see Figure 5)*.

### Rendering & Encoding the Depth Map

Once the facade model is generated using lasers or computer vision:

1. A **panoramic depth map** is rendered by tracing rays from each panorama position.
2. Each pixel in the depth map represents a lookup into a table of **3D plane equations**, enabling the client code to reconstruct real depth values at runtime.
3. The representation is further compacted using **lossless compression**.
4. The encoded depth map is only a **few kilobytes** in size and can be quickly transported over the network to enable 3D navigation at the front end *(see Figure 6)*.

### Panoramic 3D Anaglyphs

The depth map is also used to synthesize **panoramic 3D anaglyphs**, letting users experience depth in Street View with simple red-cyan eyeglasses. The approach:

- Uses the known depth to synthesize **binocular parallax** on the client side.
- Creates a second displaced view that replaces the red color channel in the original view to obtain an anaglyph *(see Figure 7)*.

---

## Computing 3D Models from Laser Data

Taking extraction of 3D information even further, Street View data is used to create **photorealistic 3D models for Google Earth**.

Traditionally, Google Earth created 3D city models from nadir or oblique airborne imagery, resulting in low-resolution facades with little detail — suitable for fly-throughs, but not for a pleasant walk-through experience. In contrast, **3D facade models reconstructed from Street View's laser scans and imagery are high resolution**.

### Facade Texture Synthesis

After filtering out noisy foreground objects, a single consistent facade texture is synthesized by:

- **Aligning, blending, and mosaicking** multiple individual camera images.
- Resolving residual pose inaccuracies between acquisition runs to avoid duplication from multiple passes.
- Determining the most suitable set of final 3D facade models for an entire city.

### Model Fusion with Airborne Data

The Street View facade models are then **registered with existing airborne models** and fused into a single model that includes:

- High-resolution facades (from Street View)
- Rooftops and back sides (from airborne view)

The result significantly enhances the user experience for walk-throughs, as demonstrated in New York City *(see Figure 8)*.

---

## Figures Summary

| Figure | Description |
|--------|-------------|
| **Figure 3** | Navigating Street View imagery: (a) correcting business locations by dragging markers; (b) navigating from Street View to user-contributed photos; (c) click-to-go feature with depth-following cursor shape. |
| **Figure 4** | Laser range data aggregated and simplified into a coarse mesh modeling dominant scene surfaces. |
| **Figure 5** | Depth recovery via optical flow for older platforms; piecewise planar facade model fitted to optical-flow data. |
| **Figure 6** | Panoramic depth map rendered by ray tracing; each pixel maps to a 3D plane equation table. |
| **Figure 7** | Panoramic 3D anaglyphs synthesized using binocular parallax; red channel replaced by displaced view. |
| **Figure 8** | Fused 3D model of NYC: (a) airborne data only; (b) Street View-enhanced with high-resolution facades. |
