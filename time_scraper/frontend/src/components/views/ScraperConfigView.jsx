import { useState, useEffect } from 'react';
import { Play, Settings, Database, ImageIcon, Shield, Layers } from 'lucide-react';
import { Card, SectionTitle, Label, Input, Toggle, Button } from '../shared/UIComponents';
import api from '../../services/api';

export function ScraperConfigView({ onStart }) {
  const [searchMode, setSearchMode] = useState(false);
  const [noReviews, setNoReviews] = useState(false);
  const [noImages, setNoImages] = useState(true);
  const [downloadImages, setDownloadImages] = useState(false);
  const [headless, setHeadless] = useState(true);
  const [enableSplit, setEnableSplit] = useState(false);
  const [splitCount, setSplitCount] = useState(3);
  const [totalItems, setTotalItems] = useState(null);
  const [countLoading, setCountLoading] = useState(false);

  const [config, setConfig] = useState({
    mode: 'traditional',
    input: 'data/places.txt',
    output: 'output/results.ndjson',
    limit: '',
    maxReviews: '1000',
    maxScrolls: '1000',
    reviewSort: 'relevant',
    imageOutput: 'output/images'
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
    const taskConfig = {
      mode: searchMode ? 'search' : 'traditional',
      input: searchMode ? undefined : config.input,
      points: searchMode ? config.points : undefined,
      categories: searchMode ? (config.categories || 'config/categories.json') : undefined,
      output: config.output,
      limit: config.limit ? parseInt(config.limit) : undefined,
      headless,
      maxReviews: noReviews ? undefined : parseInt(config.maxReviews),
      maxScrolls: noReviews ? undefined : parseInt(config.maxScrolls),
      reviewSort: noReviews ? undefined : config.reviewSort,
      noReviews,
      downloadImages,
      imageOutput: downloadImages ? config.imageOutput : undefined,
      format: 'ndjson',
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

          <div className="space-y-4">
            <div
              onClick={() => setSearchMode(false)}
              className={`p-4 border cursor-pointer transition-all ${!searchMode ? 'border-zinc-100 bg-zinc-900' : 'border-zinc-800 hover:border-zinc-600'}`}
            >
              <div className="flex items-center mb-2">
                <div className={`w-3 h-3 rounded-full mr-3 ${!searchMode ? 'bg-zinc-100' : 'bg-zinc-800'}`} />
                <span className="text-zinc-200 font-medium text-sm">Traditional Mode</span>
              </div>
              <p className="text-zinc-500 text-xs ml-6">Scrape directly from a predefined list of Place IDs.</p>
              {!searchMode && (
                <div className="mt-4 ml-6 animate-in fade-in">
                  <Label>Input File</Label>
                  <Input
                    placeholder="data/places.txt"
                    className="py-2"
                    value={config.input}
                    onChange={(e) => updateConfig('input', e.target.value)}
                  />
                </div>
              )}
            </div>

            <div
              onClick={() => setSearchMode(true)}
              className={`p-4 border cursor-pointer transition-all ${searchMode ? 'border-zinc-100 bg-zinc-900' : 'border-zinc-800 hover:border-zinc-600'}`}
            >
              <div className="flex items-center mb-2">
                <div className={`w-3 h-3 rounded-full mr-3 ${searchMode ? 'bg-zinc-100' : 'bg-zinc-800'}`} />
                <span className="text-zinc-200 font-medium text-sm">POI Search Mode</span>
              </div>
              <p className="text-zinc-500 text-xs ml-6">Search from sampling points to discover new places.</p>

              {searchMode && (
                <div className="mt-4 ml-6 space-y-3 animate-in fade-in">
                  <div>
                    <Label>Points File</Label>
                    <Input
                      placeholder="data/sg/points.csv"
                      className="py-2"
                      value={config.points || ''}
                      onChange={(e) => updateConfig('points', e.target.value)}
                    />
                  </div>
                  <div>
                    <Label>Categories Config</Label>
                    <Input
                      value={config.categories || 'config/categories.json'}
                      className="py-2"
                      onChange={(e) => updateConfig('categories', e.target.value)}
                    />
                  </div>
                </div>
              )}
            </div>
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
        <Card>
          <SectionTitle icon={ImageIcon} title="Content Extraction" />
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
          <Button variant="primary" icon={Play} className="w-full" onClick={handleStart}>
            Start Scraping
          </Button>
        </div>
      </div>

    </div>
  );
}
