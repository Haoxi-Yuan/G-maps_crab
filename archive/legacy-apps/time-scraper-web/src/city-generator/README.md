# 城市数据生成器

这个工具用于生成任意城市的边界和均匀分布的采样点，为Google Maps批量抓取系统提供输入数据。

## 功能

1. **城市边界生成** - 从OpenStreetMap获取城市行政边界
2. **采样点生成** - 使用Lloyd relaxation算法生成均匀分布的点
3. **可视化** - 生成交互式HTML地图

## 快速开始

### 基础用法

```bash
# 生成新加坡的边界和采样点
node src/city-generator/index.js --city "Singapore" --output data/singapore
```

### 指定采样点数量

```bash
# 生成500个采样点
node src/city-generator/index.js --city "Singapore" --points 500 --output data/singapore
```

### 自定义密度

```bash
# 更密集的采样(每500m x 500m一个点)
node src/city-generator/index.js \
  --city "Singapore" \
  --cell-size 500 \
  --output data/singapore_dense
```

### 使用已有边界文件

```bash
# 如果已经有城市边界GeoJSON文件
node src/city-generator/index.js \
  --boundary data/tokyo_boundary.geojson \
  --points 1000 \
  --output data/tokyo
```

## 输出文件

运行后会生成以下文件:

```
data/singapore/
├── singapore_boundary.geojson       # 城市边界
├── singapore_points.json            # 采样点(JSON格式)
├── singapore_points.csv             # 采样点(CSV格式)
├── singapore_points.geojson         # 采样点(GeoJSON格式)
├── singapore_summary.json           # 统计信息
└── singapore_visualization.html     # 可视化地图
```

## 命令行参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--city <name>` | 城市名称 | - |
| `--boundary <file>` | 使用已有边界文件 | - |
| `--points <number>` | 采样点数量 | 自动计算 |
| `--cell-size <meters>` | 单元格大小(米) | 1000 |
| `--iterations <number>` | Lloyd优化迭代次数 | 10 |
| `--output <dir>` | 输出目录 | data |

## 下一步

生成采样点后,你需要:

1. **查询POI** - 使用Google Places API查询每个采样点附近的POI
2. **获取place_id** - 收集返回的place_id
3. **生成输入文件** - 创建类似`coordinates_singapore.json`的文件
4. **运行scraper** - 使用生成的文件批量抓取数据

## 算法说明

### 采样点数量计算

```
numPoints = cityArea / (cellSize * cellSize)
```

默认情况下,每1km²生成1个采样点。

### Lloyd Relaxation

通过迭代优化点分布:
1. 生成Voronoi图
2. 计算每个Voronoi单元与城市边界的交集
3. 使用交集区域的质心作为新的点位置
4. 重复10次(默认)

这确保了点分布更加均匀,覆盖更加全面。

## 示例

### 新加坡(默认密度)

```bash
node src/city-generator/index.js --city "Singapore" --output data/singapore
```

输出: 约729个采样点(新加坡面积约728km²)

### 东京(高密度)

```bash
node src/city-generator/index.js \
  --city "Tokyo, Japan" \
  --cell-size 500 \
  --iterations 15 \
  --output data/tokyo
```

输出: 约8800个采样点(东京面积约2194km²,使用500m网格)

## 故障排除

### "No boundary data found"

**解决方案**:
1. 检查城市名称拼写
2. 尝试添加国家名称: `"Tokyo, Japan"`
3. 使用英文官方名称
4. 手动下载GeoJSON文件,使用`--boundary`参数

### Overpass API timeout

**解决方案**:
1. 等待几分钟后重试
2. Overpass API有请求频率限制
3. 对于大城市,请求可能需要较长时间

## 技术栈

- **Overpass API** - OpenStreetMap数据查询
- **Turf.js** - 地理空间计算
- **Node.js** - 运行环境
