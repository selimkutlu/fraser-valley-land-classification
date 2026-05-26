
// -------------------------------
// 1. STUDY AREAS — 7km buffer
// -------------------------------
// modify these variables to reproduce script in different locations with different buffers
var chilliwack = ee.Geometry.Point([-121.957, 49.157]);
var chilliBuffer = chilliwack.buffer(7000);
var lynden = ee.Geometry.Point([-122.452, 48.946]);
var lyndenBuffer = lynden.buffer(7000);

// -------------------------------
// 2. CLOUD MASK FUNCTIONS
// -------------------------------
function maskLandsatClouds(image, srcBands, dstBands) {
    var qa = image.select('QA_PIXEL');
    var mask = qa.bitwiseAnd(1 << 3).eq(0)
        .and(qa.bitwiseAnd(1 << 4).eq(0));
    return image.updateMask(mask)
        .multiply(0.0000275).add(-0.2)
        .select(srcBands, dstBands)
        .copyProperties(image, image.propertyNames());
}

function maskL5(image) {
    return maskLandsatClouds(image,
        ['SR_B1', 'SR_B2', 'SR_B3', 'SR_B4', 'SR_B5'],
        ['Blue', 'Green', 'Red', 'NIR', 'SWIR']);
}
function maskL8(image) {
    return maskLandsatClouds(image,
        ['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6'],
        ['Blue', 'Green', 'Red', 'NIR', 'SWIR']);
}
function maskL9(image) {
    return maskLandsatClouds(image,
        ['SR_B2', 'SR_B3', 'SR_B4', 'SR_B5', 'SR_B6'],
        ['Blue', 'Green', 'Red', 'NIR', 'SWIR']);
}

// -------------------------------
// 3. BAND DEFINITIONS + SLOPE
// -------------------------------
var years = [2000, 2005, 2010, 2015, 2020, 2025];

var summerBands = ['Blue_S', 'Green_S', 'Red_S', 'NIR_S', 'SWIR_S'];
var fallBands = ['Blue_F', 'Green_F', 'Red_F', 'NIR_F', 'SWIR_F'];

var srtm = ee.Image('USGS/SRTMGL1_003');
var slope = ee.Terrain.slope(srtm).rename('Slope');

var bands = summerBands.concat(fallBands).concat(['Slope']); // 11 bands total

// -------------------------------
// 4. STACKED COMPOSITES — leaf-on (Jun 1 - Aug 1) + leaf-off (Sep 15 - Dec 1) + slope
// -------------------------------
function getStackedComposite(buffer, year) {
    var summerCol, fallCol;

    if (year <= 2012) {
        summerCol = ee.ImageCollection('LANDSAT/LT05/C02/T1_L2')
            .filterDate(ee.Date.fromYMD(year, 6, 1), ee.Date.fromYMD(year, 9, 1))
            .filterBounds(buffer).filter(ee.Filter.lt('CLOUD_COVER', 60)).map(maskL5);
        fallCol = ee.ImageCollection('LANDSAT/LT05/C02/T1_L2')
            .filterDate(ee.Date.fromYMD(year, 9, 15), ee.Date.fromYMD(year, 12, 1))
            .filterBounds(buffer).filter(ee.Filter.lt('CLOUD_COVER', 60)).map(maskL5);
    } else if (year <= 2021) {
        summerCol = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
            .filterDate(ee.Date.fromYMD(year, 6, 1), ee.Date.fromYMD(year, 9, 1))
            .filterBounds(buffer).filter(ee.Filter.lt('CLOUD_COVER', 60)).map(maskL8);
        fallCol = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2')
            .filterDate(ee.Date.fromYMD(year, 9, 15), ee.Date.fromYMD(year, 12, 1))
            .filterBounds(buffer).filter(ee.Filter.lt('CLOUD_COVER', 60)).map(maskL8);
    } else {
        summerCol = ee.ImageCollection('LANDSAT/LC09/C02/T1_L2')
            .filterDate(ee.Date.fromYMD(year, 6, 1), ee.Date.fromYMD(year, 9, 1))
            .filterBounds(buffer).filter(ee.Filter.lt('CLOUD_COVER', 60)).map(maskL9);
        fallCol = ee.ImageCollection('LANDSAT/LC09/C02/T1_L2')
            .filterDate(ee.Date.fromYMD(year, 9, 15), ee.Date.fromYMD(year, 12, 1))
            .filterBounds(buffer).filter(ee.Filter.lt('CLOUD_COVER', 60)).map(maskL9);
    }

    var summer = ee.Algorithms.If(
        summerCol.size().gt(0),
        summerCol.median().clip(buffer).rename(summerBands),
        fallCol.median().clip(buffer).rename(summerBands)
    );

    var fall = ee.Algorithms.If(
        fallCol.size().gt(0),
        fallCol.median().clip(buffer).rename(fallBands),
        summerCol.median().clip(buffer).rename(fallBands)
    );

    return ee.Image(summer)
        .addBands(ee.Image(fall))
        .addBands(slope.clip(buffer));
}

var composites_chilli = years.map(function (y) { return getStackedComposite(chilliBuffer, y); });
var composites_lynden = years.map(function (y) { return getStackedComposite(lyndenBuffer, y); });

// FOR DEBUGGING - displaying number of bands
years.forEach(function (year, i) {
    print('Chilliwack ' + year + ' bands:', composites_chilli[i].bandNames());
    print('Lynden ' + year + ' bands:', composites_lynden[i].bandNames());
});

// -------------------------------
// 5. TRAINING POLYGONS
// -------------------------------
var polygons = ee.FeatureCollection([
    ee.Feature(forest, { 'class': 0 }),
    ee.Feature(fraser_river, { 'class': 1 }),
    ee.Feature(pond, { 'class': 2 }),
    ee.Feature(river, { 'class': 3 }),
    ee.Feature(field_agricultural, { 'class': 4 }),
    ee.Feature(industrial, { 'class': 5 }),
    ee.Feature(downtown, { 'class': 6 }),
    ee.Feature(suburban, { 'class': 7 }),
    ee.Feature(marsh_bank, { 'class': 8 })
]);

// -------------------------------
// 6. TRAIN ON 2015
// -------------------------------
var image_2015 = composites_chilli[3];

var allSamples = image_2015.sampleRegions({
    collection: polygons, // for this project, the polygons in fraservalley_training_polygons were used — change/redraw polygons when reproducing methodology elsewhere.
    properties: ['class'],
    scale: 30,
    tileScale: 4
}).randomColumn();

var trainSet = allSamples.filter(ee.Filter.lt('random', 0.8));
var valSet = allSamples.filter(ee.Filter.gte('random', 0.8));

var classifier = ee.Classifier.smileRandomForest({
    numberOfTrees: 100,
    variablesPerSplit: 3
}).train(trainSet, 'class', bands);

// -------------------------------
// 7. ACCURACY ASSESSMENT
// -------------------------------
var validated = valSet.classify(classifier);
var errorMatrix = validated.errorMatrix('class', 'classification');
print('Confusion Matrix:', errorMatrix.array());
print('Overall Accuracy:', errorMatrix.accuracy());
print('Kappa:', errorMatrix.kappa());

// -------------------------------
// 8. CLASSIFY + SMOOTH
// -------------------------------
var palette9 = ['darkgreen', 'blue', 'cyan', 'dodgerblue',
    'yellow', 'gray', 'white', 'lightgray', 'brown'];
var from9 = [0, 1, 2, 3, 4, 5, 6, 7, 8];
var to3 = [0, 0, 0, 0, 1, 2, 2, 2, 0];
var palette3 = ['green', 'yellow', 'gray'];

function classifyAndSmooth(composite) {
    return composite
        .classify(classifier)
        .focal_mode(1, 'square', 'pixels');
}

var visRGB = { min: 0, max: 0.3, bands: ['Red_S', 'Green_S', 'Blue_S'] };

// -------------------------------
// 9. DISPLAY — 2015 visible
// -------------------------------
Map.setCenter(-121.957, 49.157, 11);

var c2015 = classifyAndSmooth(composites_chilli[3]);
var l2015 = classifyAndSmooth(composites_lynden[3]);

Map.addLayer(composites_chilli[3], visRGB, 'Chilliwack RGB 2015');
Map.addLayer(composites_lynden[3], visRGB, 'Lynden RGB 2015');
Map.addLayer(c2015, { min: 0, max: 8, palette: palette9 }, 'Chilliwack 9-class 2015');
Map.addLayer(l2015, { min: 0, max: 8, palette: palette9 }, 'Lynden 9-class 2015');
Map.addLayer(c2015.remap(from9, to3), { min: 0, max: 2, palette: palette3 }, 'Chilliwack 3-class 2015');
Map.addLayer(l2015.remap(from9, to3), { min: 0, max: 2, palette: palette3 }, 'Lynden 3-class 2015');

years.forEach(function (year, i) {
    if (year === 2015) return;
    var c = classifyAndSmooth(composites_chilli[i]);
    var l = classifyAndSmooth(composites_lynden[i]);
    Map.addLayer(composites_chilli[i], visRGB, 'Chilliwack RGB ' + year, false);
    Map.addLayer(composites_lynden[i], visRGB, 'Lynden RGB ' + year, false);
    Map.addLayer(c, { min: 0, max: 8, palette: palette9 }, 'Chilliwack 9-class ' + year, false);
    Map.addLayer(l, { min: 0, max: 8, palette: palette9 }, 'Lynden 9-class ' + year, false);
    Map.addLayer(c.remap(from9, to3), { min: 0, max: 2, palette: palette3 }, 'Chilliwack 3-class ' + year, false);
    Map.addLayer(l.remap(from9, to3), { min: 0, max: 2, palette: palette3 }, 'Lynden 3-class ' + year, false);
});

Map.addLayer(polygons, { color: 'yellow' }, 'Training polygons', false);

// -------------------------------
// 10. AREA STATS — ALL YEARS, BOTH AREAS
// -------------------------------
years.forEach(function (year, i) {
    var chilli3 = classifyAndSmooth(composites_chilli[i]).remap(from9, to3);
    var lynden3 = classifyAndSmooth(composites_lynden[i]).remap(from9, to3);

    var chilliAreas = ee.Image.pixelArea().divide(10000)
        .addBands(chilli3)
        .reduceRegion({
            reducer: ee.Reducer.sum().group({ groupField: 1, groupName: 'class' }),
            geometry: chilliBuffer,
            scale: 30,
            maxPixels: 1e9,
            tileScale: 4
        }).get('groups');

    var lyndenAreas = ee.Image.pixelArea().divide(10000)
        .addBands(lynden3)
        .reduceRegion({
            reducer: ee.Reducer.sum().group({ groupField: 1, groupName: 'class' }),
            geometry: lyndenBuffer,
            scale: 30,
            maxPixels: 1e9,
            tileScale: 4
        }).get('groups');

    print('--- ' + year + ' ---');
    print('Chilliwack area (ha):', chilliAreas);
    print('Lynden area (ha):', lyndenAreas);
});

// -------------------------------
// 11. EXPORT IMAGES
// -------------------------------
var exportCRS = 'EPSG:4326';

function exportImage(image, description, region) {
    Export.image.toDrive({
        image: image, description: description,
        folder: 'FraserValley_RS_LeafOnLeafOff',
        fileNamePrefix: description, region: region,
        scale: 30, crs: exportCRS, maxPixels: 1e9, fileFormat: 'GeoTIFF'
    });
}

var vis9 = { min: 0, max: 8, palette: palette9 };
var vis3 = { min: 0, max: 2, palette: palette3 };

years.forEach(function (year, i) {
    var cc = composites_chilli[i];
    var cl = composites_lynden[i];
    var c9 = classifyAndSmooth(cc);
    var l9 = classifyAndSmooth(cl);

    exportImage(cc.visualize(visRGB), 'Chilliwack_TrueColor_' + year, chilliBuffer);
    exportImage(cl.visualize(visRGB), 'Lynden_TrueColor_' + year, lyndenBuffer);
    exportImage(c9.visualize(vis9), 'Chilliwack_9class_' + year, chilliBuffer);
    exportImage(l9.visualize(vis9), 'Lynden_9class_' + year, lyndenBuffer);
    exportImage(c9.remap(from9, to3).visualize(vis3), 'Chilliwack_3class_' + year, chilliBuffer);
    exportImage(l9.remap(from9, to3).visualize(vis3), 'Lynden_3class_' + year, lyndenBuffer);
});