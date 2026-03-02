import { useState, useEffect } from 'react';
import { MapPin, Grid3x3, RefreshCw, ArrowRight, Loader2, FolderOpen } from 'lucide-react';
import { Card, SectionTitle, Label, Input, Button } from '../shared/UIComponents';
import { CityMap } from '../shared/CityMap';
import api from '../../services/api';

export function GeneratorView({ onStartSearch }) {
  const [cityName, setCityName] = useState('');
  const [cellSize, setCellSize] = useState(2000);
  const [lloydIterations, setLloydIterations] = useState(10);
  const [loading, setLoading] = useState(false);
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

    try {
      const res = await api.generateCity({
        cityName: cityName.trim(),
        cellSize,
        lloydIterations
      });
      setBoundary(res.data.boundary);
      setPoints(res.data.points);
      setSummary(res.data.summary);
      setPointsFile(res.data.pointsFile);
      loadCities();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
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
            >
              {loading ? 'Generating...' : 'Generate Points'}
            </Button>
          </div>

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
              <div className="mt-4 pt-4 border-t border-zinc-800 flex items-center justify-between">
                <div>
                  <p className="text-zinc-500 text-xs uppercase tracking-wider">Points File</p>
                  <p className="text-zinc-300 text-sm mt-1 font-mono">{pointsFile}</p>
                </div>
                <Button
                  variant="primary"
                  icon={ArrowRight}
                  onClick={() => onStartSearch && onStartSearch(pointsFile)}
                >
                  Start POI Search
                </Button>
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
