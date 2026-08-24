import { useState, useEffect } from 'react';
import { MapPin, Grid3x3, RefreshCw, ArrowRight, Loader2, FolderOpen, ChevronDown, ChevronUp } from 'lucide-react';
import { Card, SectionTitle, Label, Input, Button } from '../shared/UIComponents';
import { CityMap } from '../shared/CityMap';
import api from '../../services/api';

export function GeneratorView({ onStartSearch, onStartSearchDirect }) {
  const [cityName, setCityName] = useState('');
  const [cellSize, setCellSize] = useState(2000);
  const [lloydIterations, setLloydIterations] = useState(10);
  const [searchZoom, setSearchZoom] = useState('1000m');
  const [maxSearchScrolls, setMaxSearchScrolls] = useState(15);
  const [allCategories, setAllCategories] = useState([]);
  const [selectedCategories, setSelectedCategories] = useState([]);
  const [catExpanded, setCatExpanded] = useState(false);
  const [boundaryFile, setBoundaryFile] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(null); // { percent, message }
  const [error, setError] = useState(null);

  // Generated data
  const [boundary, setBoundary] = useState(null);
  const [points, setPoints] = useState(null);
  const [summary, setSummary] = useState(null);
  const [pointsFile, setPointsFile] = useState(null);

  // Previously generated cities
  const [cities, setCities] = useState([]);
  const [loadingCities, setLoadingCities] = useState(true);

  useEffect(() => {
    loadCities();
    api.getCategories()
      .then(res => setAllCategories(res.categories || []))
      .catch(() => {});
  }, []);

  async function loadCities() {
    try {
      const res = await api.getGeneratorCities();
      setCities(res.cities || []);
    } catch (e) {
      // ignore
    } finally {
      setLoadingCities(false);
    }
  }

  async function handleGenerate() {
    if (!cityName.trim()) return;
    setLoading(true);
    setError(null);
    setProgress({ percent: 0, message: 'Starting...' });

    try {
      const params = { cityName: cityName.trim(), cellSize, lloydIterations };
      if (boundaryFile.trim()) {
        params.boundaryFile = boundaryFile.trim();
      }
      const res = await api.generateCity(
        params,
        (evt) => setProgress({ percent: evt.percent, message: evt.message })
      );
      setBoundary(res.data.boundary);
      setPoints(res.data.points);
      setSummary(res.data.summary);
      setPointsFile(res.data.pointsFile);
      loadCities();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }

  async function handleLoadCity(cityDir) {
    setLoading(true);
    setError(null);
    try {
      const res = await api.getGeneratorData(cityDir);
      setBoundary(res.data.boundary);
      setPoints(res.data.points);
      setSummary(res.data.summary);
      setPointsFile(res.data.pointsFile);
      setCityName(res.data.summary?.city || cityDir);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid grid-cols-12 gap-8 animate-in">
      {/* Left Column: Config */}
      <div className="col-span-12 lg:col-span-4 space-y-6">
        <Card>
          <SectionTitle
            icon={MapPin}
            title="City Generator"
            description="Generate boundary and sampling points for a new city"
          />

          <div className="space-y-4">
            <div>
              <Label required>City Name</Label>
              <Input
                placeholder="e.g. Singapore, Tokyo, Hong Kong"
                value={cityName}
                onChange={e => setCityName(e.target.value)}
                disabled={loading}
              />
            </div>

            <div>
              <Label>Boundary File (optional)</Label>
              <Input
                placeholder="e.g. data/Galicia/Galicia.geojson"
                value={boundaryFile}
                onChange={e => setBoundaryFile(e.target.value)}
                disabled={loading}
              />
              <p className="text-zinc-600 text-xs mt-1">
                Load local GeoJSON instead of Overpass API. Supports projected CRS and LineString auto-conversion.
              </p>
            </div>

            <div>
              <Label>Cell Size (meters)</Label>
              <Input
                type="number"
                value={cellSize}
                onChange={e => setCellSize(Number(e.target.value))}
                disabled={loading}
              />
              <p className="text-zinc-600 text-xs mt-1">
                Controls point density. 2000m = ~1 point per 4 km²
              </p>
            </div>

            <div>
              <Label>Lloyd Iterations</Label>
              <Input
                type="number"
                value={lloydIterations}
                onChange={e => setLloydIterations(Number(e.target.value))}
                disabled={loading}
              />
              <p className="text-zinc-600 text-xs mt-1">
                More iterations = more uniform distribution
              </p>
            </div>

            <Button
              onClick={handleGenerate}
              icon={loading ? Loader2 : RefreshCw}
              className={`w-full mt-2 ${loading ? 'opacity-60 cursor-wait' : ''}`}
              disabled={loading}
            >
              {loading ? 'Generating...' : 'Generate Points'}
            </Button>
          </div>

          {progress && (
            <div className="mt-4 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-400">{progress.message}</span>
                <span className="text-zinc-500">{progress.percent}%</span>
              </div>
              <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-zinc-400 rounded-full transition-all duration-300 ease-out"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
            </div>
          )}

          {error && (
            <div className="mt-4 p-3 bg-red-900/20 border border-red-900/30 text-red-400 text-xs">
              {error}
            </div>
          )}
        </Card>

        {/* Previously generated cities */}
        <Card>
          <SectionTitle
            icon={FolderOpen}
            title="Generated Cities"
            description="Load previously generated data"
          />
          {loadingCities ? (
            <p className="text-zinc-600 text-xs">Loading...</p>
          ) : cities.length === 0 ? (
            <p className="text-zinc-600 text-xs">No cities generated yet</p>
          ) : (
            <div className="space-y-2 max-h-48 overflow-y-auto custom-scrollbar">
              {cities.map(city => (
                <button
                  key={city.dir}
                  onClick={() => handleLoadCity(city.dir)}
                  className="w-full text-left p-3 bg-zinc-950 border border-zinc-800 hover:border-zinc-600 transition-colors"
                >
                  <div className="text-zinc-300 text-sm font-medium">{city.city}</div>
                  <div className="text-zinc-600 text-xs mt-1">
                    {city.pointCount} points &middot; {city.area_km2} km²
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Right Column: Map + Summary */}
      <div className="col-span-12 lg:col-span-8 space-y-6">
        <Card>
          <SectionTitle
            icon={Grid3x3}
            title="Map Preview"
            description={summary ? `${summary.city} — ${summary.points?.count} sampling points` : 'Generate points to see preview'}
          />
          <CityMap
            boundary={boundary}
            points={points}
            height="450px"
          />
        </Card>

        {summary && (
          <Card>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Stat label="Points" value={summary.points?.count} />
              <Stat label="Area" value={`${summary.boundary?.area_km2} km²`} />
              <Stat label="Density" value={`${summary.points?.density_per_km2} /km²`} />
              <Stat label="Cell Size" value={`${summary.params?.cellSize || cellSize}m`} />
            </div>

            {pointsFile && (
              <div className="mt-4 pt-4 border-t border-zinc-800 space-y-4">
                <div>
                  <p className="text-zinc-500 text-xs uppercase tracking-wider">Points File</p>
                  <p className="text-zinc-300 text-sm mt-1 font-mono">{pointsFile}</p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Search Zoom</Label>
                    <Input
                      value={searchZoom}
                      onChange={e => setSearchZoom(e.target.value)}
                    />
                    <p className="text-zinc-600 text-xs mt-1">Radius, e.g. 1000m, 500m</p>
                  </div>
                  <div>
                    <Label>Max Search Scrolls</Label>
                    <Input
                      type="number"
                      value={maxSearchScrolls}
                      onChange={e => setMaxSearchScrolls(Number(e.target.value))}
                    />
                    <p className="text-zinc-600 text-xs mt-1">Scrolls per search query</p>
                  </div>
                </div>

                {/* Category Picker */}
                <div>
                  <Label>Categories</Label>
                  {(() => {
                    const allSelected = selectedCategories.length === 0 || selectedCategories.length === allCategories.length;
                    const displayCount = allSelected
                      ? `All ${allCategories.length} categories`
                      : `${selectedCategories.length} of ${allCategories.length} selected`;
                    return (
                      <>
                        <button
                          type="button"
                          onClick={() => setCatExpanded(!catExpanded)}
                          className="w-full flex items-center justify-between bg-zinc-900 border border-zinc-800 text-zinc-300 text-sm px-3 py-2 hover:border-zinc-600 transition-colors"
                        >
                          <span>{displayCount}</span>
                          {catExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                        </button>
                        {catExpanded && (
                          <div className="border border-t-0 border-zinc-800 bg-zinc-950 animate-in fade-in">
                            <div className="px-3 py-2 border-b border-zinc-800">
                              <button type="button" onClick={() => setSelectedCategories(allSelected ? [] : [...allCategories])} className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors">
                                {allSelected ? 'Deselect All' : 'Select All'}
                              </button>
                            </div>
                            <div className="max-h-48 overflow-y-auto custom-scrollbar p-2 grid grid-cols-2 gap-1">
                              {allCategories.map(cat => {
                                const checked = allSelected || selectedCategories.includes(cat);
                                return (
                                  <label key={cat} className="flex items-center gap-2 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-900 cursor-pointer rounded">
                                    <input type="checkbox" checked={checked} onChange={() => {
                                      if (selectedCategories.includes(cat)) {
                                        setSelectedCategories(selectedCategories.filter(c => c !== cat));
                                      } else {
                                        setSelectedCategories([...selectedCategories, cat]);
                                      }
                                    }} className="accent-zinc-400" />
                                    {cat}
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>

                <div className="flex items-center justify-end space-x-3">
                  <Button
                    variant="primary"
                    icon={ArrowRight}
                    onClick={() => {
                      if (onStartSearchDirect) {
                        onStartSearchDirect({
                          pointsFile,
                          searchZoom,
                          maxSearchScrolls,
                          categories: 'config/categories.json',
                          selectedCategories: selectedCategories.length > 0 ? selectedCategories : undefined
                        });
                      } else if (onStartSearch) {
                        onStartSearch(pointsFile);
                      }
                    }}
                  >
                    Start POI Search
                  </Button>
                </div>
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="text-center">
      <p className="text-zinc-500 text-xs uppercase tracking-wider">{label}</p>
      <p className="text-zinc-100 text-xl font-light mt-1">{value ?? '—'}</p>
    </div>
  );
}
