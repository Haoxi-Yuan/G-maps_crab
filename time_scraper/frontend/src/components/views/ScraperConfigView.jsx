import { useState, useEffect } from 'react';
import { Play, Settings, Database, ImageIcon, Shield, Layers, Search, ChevronDown, ChevronUp } from 'lucide-react';
import { Card, SectionTitle, Label, Input, Toggle, Button } from '../shared/UIComponents';
import api from '../../services/api';

function CategoryPicker({ selectedCategories, onChangeCategories }) {
  const [allCategories, setAllCategories] = useState([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    api.getCategories()
      .then(res => setAllCategories(res.categories || []))
      .catch(() => {});
  }, []);

  const allSelected = selectedCategories.length === 0 || selectedCategories.length === allCategories.length;

  const toggleCategory = (cat) => {
    if (selectedCategories.includes(cat)) {
      const next = selectedCategories.filter(c => c !== cat);
      onChangeCategories(next);
    } else {
      onChangeCategories([...selectedCategories, cat]);
    }
  };

  const toggleAll = () => {
    onChangeCategories(allSelected ? [] : [...allCategories]);
  };

  const displayCount = allSelected
    ? `All ${allCategories.length} categories`
    : `${selectedCategories.length} of ${allCategories.length} selected`;

  return (
    <div>
      <Label>Categories</Label>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between bg-zinc-900 border border-zinc-800 text-zinc-300 text-sm px-3 py-2 hover:border-zinc-600 transition-colors"
      >
        <span>{displayCount}</span>
        {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>
      {expanded && (
        <div className="border border-t-0 border-zinc-800 bg-zinc-950 animate-in fade-in">
          <div className="px-3 py-2 border-b border-zinc-800 flex items-center justify-between">
            <button
              type="button"
              onClick={toggleAll}
              className="text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              {allSelected ? 'Deselect All' : 'Select All'}
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto custom-scrollbar p-2 grid grid-cols-2 gap-1">
            {allCategories.map(cat => {
              const checked = allSelected || selectedCategories.includes(cat);
              return (
                <label key={cat} className="flex items-center gap-2 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-900 cursor-pointer rounded">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleCategory(cat)}
                    className="accent-zinc-400"
                  />
                  {cat}
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Task type modes: 'search' (POI search only), 'scrape' (from place_ids), 'search+scrape' (coupled)
export function ScraperConfigView({ onStart, prefillPointsFile, onPrefillConsumed }) {
  const [taskType, setTaskType] = useState('scrape');
  const searchMode = taskType === 'search' || taskType === 'search+scrape';

  // Handle prefill from GeneratorView
  useEffect(() => {
    if (prefillPointsFile) {
      setTaskType('search');
      setConfig(prev => ({ ...prev, points: prefillPointsFile }));
      if (onPrefillConsumed) onPrefillConsumed();
    }
  }, [prefillPointsFile]);
  const [noReviews, setNoReviews] = useState(false);
  const [noImages, setNoImages] = useState(true);
  const [downloadImages, setDownloadImages] = useState(false);
  const [headless, setHeadless] = useState(true);
  const [enableSplit, setEnableSplit] = useState(false);
  const [splitCount, setSplitCount] = useState(3);
  const [totalItems, setTotalItems] = useState(null);
  const [countLoading, setCountLoading] = useState(false);

  const [selectedCategories, setSelectedCategories] = useState([]);

  const [config, setConfig] = useState({
    mode: 'traditional',
    input: 'data/places.txt',
    output: 'output/results.ndjson',
    limit: '',
    maxReviews: '1000',
    maxScrolls: '1000',
    reviewSort: 'relevant',
    imageOutput: 'output/images',
    searchZoom: '1000m',
    maxSearchScrolls: '15'
  });

  const updateConfig = (key, value) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  // Auto-count items when parallel split is enabled and input file changes
  const inputFile = searchMode ? config.points : config.input;
  useEffect(() => {
    if (!enableSplit || !inputFile) {
      setTotalItems(null);
      return;
    }
    setCountLoading(true);
    api.countItems(inputFile, searchMode ? 'search' : 'traditional')
      .then(res => setTotalItems(res.count))
      .catch(() => setTotalItems(null))
      .finally(() => setCountLoading(false));
  }, [enableSplit, inputFile, searchMode]);

  // Generate output filename preview from input filename
  const getBaseName = (filePath) => {
    if (!filePath) return 'output';
    const fileName = filePath.split('/').pop();
    return fileName.replace(/\.[^.]+$/, '');
  };

  const baseName = getBaseName(inputFile);

  const splitOutputPreview = enableSplit && inputFile
    ? Array.from({ length: Math.min(splitCount, 3) }, (_, i) => {
        const suffix = String(i + 1).padStart(3, '0');
        return `output/${baseName}_${suffix}.ndjson`;
      }).join(', ') + (splitCount > 3 ? `, ... (${splitCount} files)` : '')
    : '';

  const splitImagePreview = enableSplit && inputFile && downloadImages
    ? `output/images/${baseName}/ {` + Array.from({ length: Math.min(splitCount, 3) }, (_, i) =>
        String(i + 1).padStart(3, '0')
      ).join(', ') + (splitCount > 3 ? `, ...` : '') + `}`
    : '';

  const handleStart = () => {
    const isSearchOnly = taskType === 'search';
    const taskConfig = {
      taskType,
      mode: searchMode ? 'search' : 'traditional',
      input: searchMode ? undefined : config.input,
      points: searchMode ? config.points : undefined,
      categories: searchMode ? (config.categories || 'config/categories.json') : undefined,
      selectedCategories: searchMode && selectedCategories.length > 0 ? selectedCategories : undefined,
      searchZoom: searchMode ? config.searchZoom : undefined,
      maxSearchScrolls: searchMode ? parseInt(config.maxSearchScrolls) : undefined,
      output: isSearchOnly
        ? (config.output.endsWith('.ndjson')
            ? config.output.replace(/\.ndjson$/, '.search_results.json')
            : config.output)
        : config.output,
      limit: config.limit ? parseInt(config.limit) : undefined,
      headless,
      // Search-only tasks don't need scrape config
      maxReviews: isSearchOnly || noReviews ? undefined : parseInt(config.maxReviews),
      maxScrolls: isSearchOnly || noReviews ? undefined : parseInt(config.maxScrolls),
      reviewSort: isSearchOnly || noReviews ? undefined : config.reviewSort,
      noReviews: isSearchOnly ? undefined : noReviews,
      downloadImages: isSearchOnly ? undefined : downloadImages,
      imageOutput: isSearchOnly || !downloadImages ? undefined : config.imageOutput,
      format: isSearchOnly ? undefined : 'ndjson',
      randomDelay: true
    };

    if (enableSplit && splitCount >= 2) {
      onStart({ ...taskConfig, parallel: true, splitCount });
    } else {
      onStart(taskConfig);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 animate-in fade-in slide-in-from-bottom-4 duration-500">

      <div className="lg:col-span-4 space-y-6">
        <Card className="h-full">
          <SectionTitle icon={Database} title="Operation Mode" />

          <div className="space-y-3">
            {/* POI Search Only */}
            <ModeOption
              active={taskType === 'search'}
              onClick={() => setTaskType('search')}
              title="POI Search Only"
              description="Discover place_ids from sampling points. No scraping."
            >
              {taskType === 'search' && (
                <div className="mt-4 ml-6 space-y-3 animate-in fade-in">
                  <div>
                    <Label>Points File</Label>
                    <Input placeholder="data/city/points.csv" className="py-2" value={config.points || ''} onChange={(e) => updateConfig('points', e.target.value)} />
                  </div>
                  <CategoryPicker selectedCategories={selectedCategories} onChangeCategories={setSelectedCategories} />
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Search Zoom</Label>
                      <Input value={config.searchZoom} className="py-2" onChange={(e) => updateConfig('searchZoom', e.target.value)} />
                      <p className="text-zinc-600 text-xs mt-1">Radius, e.g. 1000m, 500m</p>
                    </div>
                    <div>
                      <Label>Max Search Scrolls</Label>
                      <Input type="number" value={config.maxSearchScrolls} className="py-2" onChange={(e) => updateConfig('maxSearchScrolls', e.target.value)} />
                      <p className="text-zinc-600 text-xs mt-1">Scrolls per search query</p>
                    </div>
                  </div>
                </div>
              )}
            </ModeOption>

            {/* Scrape from Place IDs */}
            <ModeOption
              active={taskType === 'scrape'}
              onClick={() => setTaskType('scrape')}
              title="Scrape from Place IDs"
              description="Scrape details from an existing place_id list."
            >
              {taskType === 'scrape' && (
                <div className="mt-4 ml-6 animate-in fade-in">
                  <Label>Input File</Label>
                  <Input placeholder="data/places.txt" className="py-2" value={config.input} onChange={(e) => updateConfig('input', e.target.value)} />
                </div>
              )}
            </ModeOption>

            {/* Search + Scrape (coupled) */}
            <ModeOption
              active={taskType === 'search+scrape'}
              onClick={() => setTaskType('search+scrape')}
              title="Search + Scrape"
              description="POI search then scrape in one task (legacy)."
            >
              {taskType === 'search+scrape' && (
                <div className="mt-4 ml-6 space-y-3 animate-in fade-in">
                  <div>
                    <Label>Points File</Label>
                    <Input placeholder="data/city/points.csv" className="py-2" value={config.points || ''} onChange={(e) => updateConfig('points', e.target.value)} />
                  </div>
                  <CategoryPicker selectedCategories={selectedCategories} onChangeCategories={setSelectedCategories} />
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Search Zoom</Label>
                      <Input value={config.searchZoom} className="py-2" onChange={(e) => updateConfig('searchZoom', e.target.value)} />
                      <p className="text-zinc-600 text-xs mt-1">Radius, e.g. 1000m, 500m</p>
                    </div>
                    <div>
                      <Label>Max Search Scrolls</Label>
                      <Input type="number" value={config.maxSearchScrolls} className="py-2" onChange={(e) => updateConfig('maxSearchScrolls', e.target.value)} />
                      <p className="text-zinc-600 text-xs mt-1">Scrolls per search query</p>
                    </div>
                  </div>
                </div>
              )}
            </ModeOption>
          </div>
        </Card>
      </div>

      <div className="lg:col-span-4 space-y-6">
        <Card>
          <SectionTitle icon={Settings} title="General Config" />
          <div className="space-y-4">
            <div className={enableSplit ? 'opacity-40 pointer-events-none' : ''}>
              <Label required>Output File</Label>
              <Input
                value={config.output}
                onChange={(e) => updateConfig('output', e.target.value)}
                disabled={enableSplit}
              />
            </div>

            <div className="pt-1">
              <Toggle
                label="Parallel Split"
                checked={enableSplit}
                onChange={setEnableSplit}
              />
            </div>

            {enableSplit && (
              <div className="pl-4 border-l border-zinc-700 space-y-3 animate-in fade-in">
                <div>
                  <Label>Split Into Parts</Label>
                  <Input
                    type="number"
                    min="2"
                    max="10"
                    value={splitCount}
                    onChange={(e) => {
                      const v = parseInt(e.target.value);
                      if (v >= 2 && v <= 10) setSplitCount(v);
                    }}
                  />
                </div>
                {countLoading && (
                  <div className="text-xs text-zinc-500">Counting items...</div>
                )}
                {totalItems !== null && !countLoading && (
                  <div className="text-xs text-zinc-400">
                    Total: <span className="text-zinc-200 font-medium">{totalItems}</span> items
                    {' / '}
                    ~<span className="text-zinc-200 font-medium">{Math.ceil(totalItems / splitCount)}</span> per part
                  </div>
                )}
                {splitOutputPreview && (
                  <div className="text-[11px] text-zinc-500 break-all leading-relaxed">
                    <Layers className="w-3 h-3 inline-block mr-1 -mt-0.5" />
                    {splitOutputPreview}
                  </div>
                )}
              </div>
            )}

            <div className={`grid grid-cols-2 gap-4 ${enableSplit ? 'opacity-40 pointer-events-none' : ''}`}>
              <div>
                <Label>Limit</Label>
                <Input
                  placeholder="All"
                  value={config.limit}
                  onChange={(e) => updateConfig('limit', e.target.value)}
                  disabled={enableSplit}
                />
              </div>
              <div>
                <Label>Restart Every</Label>
                <Input defaultValue="50" />
              </div>
            </div>
            <div className="pt-2">
              <Toggle label="Headless Mode" checked={headless} onChange={setHeadless} />
            </div>
          </div>
        </Card>

        <Card>
          <SectionTitle icon={Shield} title="Don't Get Caught" />
          <div className="space-y-4">
            <Toggle label="Use Proxy" checked={false} onChange={() => {}} />
            <Input placeholder="Proxy Config Path" disabled={true} />
            <Toggle label="Random Delay" checked={true} onChange={() => {}} />
          </div>
        </Card>
      </div>

      <div className="lg:col-span-4 space-y-6">
        <Card className={taskType === 'search' ? 'opacity-30 pointer-events-none' : ''}>
          <SectionTitle icon={ImageIcon} title="Content Extraction" description={taskType === 'search' ? 'Not applicable for search-only mode' : undefined} />
          <div className="space-y-3">
            <Toggle label="Extract Reviews" checked={!noReviews} onChange={(v) => setNoReviews(!v)} />

            <div className={`pl-4 border-l border-zinc-800 space-y-3 ${noReviews ? 'opacity-30 pointer-events-none' : ''}`}>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Max Reviews</Label>
                  <Input
                    value={config.maxReviews}
                    onChange={(e) => updateConfig('maxReviews', e.target.value)}
                  />
                </div>
                <div>
                  <Label>Max Scrolls</Label>
                  <Input
                    value={config.maxScrolls}
                    onChange={(e) => updateConfig('maxScrolls', e.target.value)}
                  />
                </div>
              </div>
              <div>
                <Label>Review Sort Order</Label>
                <select
                  value={config.reviewSort}
                  onChange={(e) => updateConfig('reviewSort', e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 text-zinc-200 text-sm px-3 py-2 focus:outline-none focus:border-zinc-600 transition-colors"
                >
                  <option value="relevant">Most Relevant</option>
                  <option value="newest">Newest</option>
                  <option value="highest">Highest Rating</option>
                  <option value="lowest">Lowest Rating</option>
                </select>
              </div>
              <Toggle
                label="Extract Images"
                checked={!noImages}
                onChange={(v) => setNoImages(!v)}
              />
              <Toggle
                label="Download to Disk"
                checked={downloadImages}
                onChange={setDownloadImages}
                disabled={noImages}
              />
              {downloadImages && (
                <div className="animate-in fade-in">
                  <div className={enableSplit ? 'opacity-40 pointer-events-none' : ''}>
                    <Label>Image Directory</Label>
                    <Input
                      value={config.imageOutput}
                      onChange={(e) => updateConfig('imageOutput', e.target.value)}
                      disabled={enableSplit}
                    />
                  </div>
                  {splitImagePreview && (
                    <div className="text-[11px] text-zinc-500 break-all leading-relaxed mt-2">
                      <Layers className="w-3 h-3 inline-block mr-1 -mt-0.5" />
                      {splitImagePreview}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </Card>

        <div className="pt-4">
          <Button variant="primary" icon={taskType === 'search' ? Search : Play} className="w-full" onClick={handleStart}>
            {taskType === 'search' ? 'Start POI Search' : 'Start Scraping'}
          </Button>
        </div>
      </div>

    </div>
  );
}

function ModeOption({ active, onClick, title, description, children }) {
  return (
    <div
      onClick={onClick}
      className={`p-4 border cursor-pointer transition-all ${active ? 'border-zinc-100 bg-zinc-900' : 'border-zinc-800 hover:border-zinc-600'}`}
    >
      <div className="flex items-center mb-1">
        <div className={`w-3 h-3 rounded-full mr-3 ${active ? 'bg-zinc-100' : 'bg-zinc-800'}`} />
        <span className="text-zinc-200 font-medium text-sm">{title}</span>
      </div>
      <p className="text-zinc-500 text-xs ml-6">{description}</p>
      {children}
    </div>
  );
}
