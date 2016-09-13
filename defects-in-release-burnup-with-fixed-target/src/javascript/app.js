Ext.define("TSFixedTargetReleaseBurnup", {
    extend: 'Rally.app.App',
    componentCls: 'app',
    logger: new Rally.technicalservices.Logger(),
    defaults: { margin: 10 },
    items: [
        {xtype:'container',itemId:'selector_box', layout: 'hbox'},
        {xtype:'container',itemId:'display_box'}
    ],

    release: null,
    granularity: 'day',
    all_values: [],
    
    config: {
        defaultSettings: {
            closedStateValues: ['Closed'],
            sprintTargetField: 'ChildrenPlannedVelocity'
        }
    },
    
    integrationHeaders : {
        name : "TSReleaseDefectChart"
    },
                        
    launch: function() {
        this._addSelectors(this.down('#selector_box'));
    },
    
    _addSelectors: function(container) {
        container.add({
            xtype:'rallyreleasecombobox',
            margin: 10,

            listeners: {
                scope: this,
                change: function(cb) {
                    this.release = cb.getRecord();
                    this._updateData();
                }
            }
        });
        
        container.add({xtype:'container',flex:1});
        
//        container.add({
//            xtype: 'rallybutton',
//            iconCls: 'icon-export secondary rly-small',
//            margin: 10,
//            listeners: {
//                click: this._export,
//                scope: this
//            }
//        });
        
        container.add({
            xtype: 'container',
            itemId: 'etlDate',
            padding: 10,
            tpl: '<tpl><div class="etlDate">Data current as of {etlDate}</div></tpl>'
        });
    },
    
    _updateData: function() {
        var me = this;
        this.down('#display_box').removeAll();
        
        if ( Ext.isEmpty(this.release) ) {
            return;
        }
        this.setLoading("Loading Release Information...");

        this.base_filter = this.getSetting('defectFilter');
        
        if ( !Ext.isEmpty(this.base_filter) && Ext.isString(this.base_filter) ) { this.base_filter = Ext.JSON.decode(this.base_filter); }
        
        Deft.Chain.pipeline([
            this._getIterations,
            this._getChildIterations,
            //this._getDefectsInRelease,
            this._getDefectLookbackData,
            this._makeChart
        ],this).always(function() { me.setLoading(false); });        
    },
    
    _getIterations: function() {
        var deferred = Ext.create('Deft.Deferred');
        
        var release = this.release;
        
        var fetch = ['StartDate','Name','EndDate'];
        var target_field = this.getSetting('sprintTargetField');

        if ( !Ext.isEmpty(target_field) ) { fetch.push(target_field); }
        
        var end_date = new Date();
        if ( release.get('ReleaseDate') < end_date ) {
            end_date = release.get('ReleaseDate');
        }
        var filters = Rally.data.wsapi.Filter.and([
            {property:'StartDate',operator:'>=',value: release.get('ReleaseStartDate')},
            {property:'StartDate',operator:'<=',value: end_date},
            {property:'EndDate',operator:'<=',value: release.get('ReleaseDate')}
        ]);
        
        var config = {
            model:'Iteration',
            limit:Infinity,
            filters: filters,
            fetch: fetch,
            context: {
                projectScopeUp: false,
                projectScopeDown: false
            }
        };
        
        TSUtilities.loadWsapiRecords(config).then({
            success: function(results) {
                this.iterations = results;
                deferred.resolve();
            },
            failure: function(msg) {
                deferred.reject(msg);
            },
            scope: this
        });
        
        return deferred.promise;
    },
    
    _getChildIterations: function() {
        var deferred = Ext.create('Deft.Deferred');
        
        var release = this.release;
        
        var fetch = ['StartDate','Name','EndDate','Project','Children'];
        var target_field = this.getSetting('sprintTargetField');

        if ( !Ext.isEmpty(target_field) ) { fetch.push(target_field); }
        
        var end_date = new Date();
        if ( release.get('ReleaseDate') < end_date ) {
            end_date = release.get('ReleaseDate');
        }
        var filters = Rally.data.wsapi.Filter.and([
            {property:'StartDate',operator:'>=',value: release.get('ReleaseStartDate')},
            {property:'StartDate',operator:'<=',value: end_date},
            {property:'EndDate',operator:'<=',value: release.get('ReleaseDate')}
        ]);
        
        var config = {
            model:'Iteration',
            limit:Infinity,
            filters: filters,
            fetch: fetch
        };
        
        TSUtilities.loadWsapiRecords(config).then({
            success: function(results) {
                console.log(results);
                this.child_iterations = Ext.Array.filter(results, function(result){
                    return ( result.get('Project').Children.Count === 0 );
                });
                deferred.resolve();
            },
            failure: function(msg) {
                deferred.reject(msg);
            },
            scope: this
        });
        
        return deferred.promise;
    },
    
    _getDefectsInRelease: function() {
        var release = this.release;
        
        // Changed: get all defects
        var filters = [{property:'ObjectID',operator:'>',value:0}];
//        var filters = Rally.data.wsapi.Filter.or([
//            {property:'Release.Name', value: release.get('Name')},
//            {property:'Requirement.Release.Name',value:release.get('Name')}
//        ]);
        
        var config = {
            model: 'Defect',
            limit:Infinity,
            pageSize: 2000,
            filters: filters,
            fetch: ['ObjectID','State']
        };
        
        return TSUtilities.loadWsapiRecords(config);
    },
    
    // loop through the sprints, do each sprint's last day data
    _getDefectLookbackData: function(defects) {
        var me = this,
            deferred = Ext.create('Deft.Deferred');

        var oids = Ext.Array.map(defects || [], function(defect){
            return defect.get('ObjectID');
        });
        
        var promises = [];
        
        Ext.Array.each(this.iterations, function(iteration){
            var end_date = new Date();
            if ( iteration.get('EndDate') < end_date ) { end_date = iteration.get('EndDate'); }
            
            promises.push(
                function() {
                    return me._getDefectLookbackDataForSprint(end_date,oids);
                }
            );
        });
        
        
        Deft.Chain.sequence(promises,me).then({
            success: function(results) {
                var closedStates = this.getSetting('closedStateValues') || [];
                if ( !Ext.isArray(closedStates) ) { closedStates = closedStates.split(/,/); }
                
                var open_series = {
                    name: 'Product Defects',
                    data: Ext.Array.map(results, function(result_set){
                        
                        var open_defects = Ext.Array.filter(result_set, function(result){
                            return !Ext.Array.contains(closedStates,result.get('State'));
                        });
                        
                        return open_defects.length;
                    })
                };
                
                var closed_series = {
                    name: 'Fixed in Release',
                    data: Ext.Array.map(results, function(result_set){
                        
                        var closed_defects = Ext.Array.filter(result_set, function(result){
                            return Ext.Array.contains(closedStates,result.get('State'));
                        });
                        
                        return closed_defects.length;
                    })
                };
                
                var target_series = this._getTargetSeries();
                
                deferred.resolve([open_series,target_series,closed_series]);
            },
            failure: function(msg) {
                deferred.reject(msg);
            },
            scope: this
        });
        
        return deferred.promise;
    },
    
    _getTargetSeries: function() {
        var target_field = this.getSetting('sprintTargetField');
        var targets_by_iteration_name = {};
        Ext.Array.each(this.child_iterations, function(iteration) {
            var target = iteration.get(target_field) || 0;
            var name = iteration.get('Name');
            
            if ( Ext.isEmpty(targets_by_iteration_name[name]) ) {
                targets_by_iteration_name[name] = 0;
            }
            
            targets_by_iteration_name[name] = targets_by_iteration_name[name] + target;
        });
        
        var series = {
            name: 'Release Target',
            data: Ext.Array.map(this.iterations, function(iteration){
                var name = iteration.get('Name');
                return targets_by_iteration_name[name] || 0;
            })
        };
        
        return series;
        
    },
    
    _getDefectLookbackDataForSprint: function(end_date,defect_oids) {    
        var filters = [];
        
        if ( defect_oids.length > 0 ) {
            filters.push({property:'ObjectID',operator:'in',value:defect_oids});
        }
        
        Ext.Array.push(filters, [
            {property:'_TypeHierarchy',value:'Defect'},
            {property:'_ProjectHierarchy',value: this.getContext().getProject().ObjectID},
            {property:'__At', value: Rally.util.DateTime.toIsoString(end_date) }
        ]);
        
        if ( !Ext.isEmpty( this.base_filter ) ) {
            this.logger.log("Using base filter: ", this.base_filter);
            filters.push(this.base_filter);
        }
        
        var config = {
            fetch: ['State','ObjectID'],
            hydrate: ['State'],
            removeUnauthorizedSnapshots: true,
            filters: filters
        };
        
        return TSUtilities.loadLookbackRecords(config);
    },
    
    _makeChart: function(series) {
        var deferred = Ext.create('Deft.Deferred');
        
        this.setLoading("Calculating...");
        var container = this.down('#display_box');

        var categories = this._getCategories(this.iterations);

        if ( categories.length === 0 ) {
            container.add({xtype:'container',html:'No Iterations in Release'});
            return;
        }

        container.add({
            xtype: 'rallychart',
            chartData: { series: series, categories: categories },
            chartConfig: this._getChartConfig()
        });
    },
    
    _getCategories: function(iterations) {
        return Ext.Array.map(iterations, function(iteration) {
            return iteration.get('Name');
        });
    },
    
    _getChartStoreConfig: function(oids) {        
        return {
           find: {
               ObjectID: { "$in": oids },
               _ProjectHierarchy: this.getContext().getProject().ObjectID , 
               _TypeHierarchy: 'Defect' 
           },
           removeUnauthorizedSnapshots: true,
           fetch: ['ObjectID','State','FormattedID',this.group_field,'CreationDate'],
           hydrate: ['State',this.group_field],
           sort: {
               '_ValidFrom': 1
           },
           limit: Infinity,
           listeners: {
               load: this._updateETLDate,
               scope: this
           }
        };
    },
    
    _getChartConfig: function() {
        return {
            chart: {
                zoomType: 'xy'
            },
            title: {
                text: 'Defect Trend'
            },
            xAxis: {
                tickmarkPlacement: 'on',
                title: {
                    text: 'Sprint'
                },
                labels            : {
                    rotation : -45
                }
            },
            yAxis: [
                {
                    min: 0,
                    title: {
                        text: 'Count'
                    },
                    opposite: false
                }
            ],
            tooltip: { shared: true },
            plotOptions: {
                series: {
                    marker: {
                        enabled: false
                    }
                },
                column: {
                    stacking: 'normal'
                }
            }
        };
    },
    
    _getTickInterval: function(granularity) {
        if ( Ext.isEmpty(granularity) ) { return 30; }
        
        
        granularity = granularity.toLowerCase();
        if (this.timebox_limit < 30) {
            return 1;
        }
        if ( granularity == 'day' ) { return 30; }
        
        return 1;
        
    },
    
    getOptions: function() {
        return [
            {
                text: 'About...',
                handler: this._launchInfo,
                scope: this
            }
        ];
    },
    
    _launchInfo: function() {
        if ( this.about_dialog ) { this.about_dialog.destroy(); }
        this.about_dialog = Ext.create('Rally.technicalservices.InfoLink',{});
    },
    
    isExternal: function(){
        return typeof(this.getAppId()) == 'undefined';
    },
    
    getSettingsFields: function() {
        var me = this;
        var left_margin = 5;
        return [{
            name: 'defectFilter',
            xtype: 'tssettingsfilterfield',
            label: 'Filter:',
            labelWidth: 150,
            margin: 5,
            model: 'Defect'
        },{
            name: 'sprintTargetField',
            xtype: 'rallyfieldcombobox',
            model: 'Iteration',
            label: 'Sprint Target Field:',
            labelWidth: 150,
            margin: 5,
            _isNotHidden: function(field) {
                if ( field.hidden ) { return false; }
                var defn = field.attributeDefinition;
                if ( Ext.isEmpty(defn) ) { return false; }
                
                var valid_types = ['INTEGER','QUANTITY','DECIMAL'];
                return ( Ext.Array.contains(valid_types,defn.AttributeType) );
            }        
            //
        },{
            name: 'closedStateValues',
            xtype: 'tsmultifieldvaluepicker',
            model: 'Defect',
            field: 'State',
            margin: left_margin,
            fieldLabel: 'States to Consider Closed',
            labelWidth: 150,
            margin: '5 5 100 5',
            readyState: 'ready'
        }];
    },
    
    _updateETLDate: function(store, records, success){
//        this.logger.log('_updateETLDate', store, records, success);
//        var etlDate = store && store.proxy && store.proxy._etlDate;
//        if (etlDate){
//            this.down('#etlDate').update({etlDate: Rally.util.DateTime.fromIsoString(etlDate)});
//        }
    },
    
    _export: function(){
        var me = this,
            chart = this.down('rallychart'),
            snapshots = chart && chart.calculator && chart.calculator.snapshots,
            chartEndDate = chart.calculator.endDate,
            chartStartDate = chart.calculator.startDate;
        this.logger.log('_Export', chart.calculator ,chartStartDate, chartEndDate);
        if (snapshots){
            var csv = [];
            var headers = ['FormattedID',me.group_field,'State','_ValidFrom','_ValidTo'];
            csv.push(headers.join(','));
            Ext.Array.each(snapshots, function(s){
                var validFrom = Rally.util.DateTime.fromIsoString(s._ValidFrom),
                    validTo = Rally.util.DateTime.fromIsoString(s._ValidTo);

                if (validFrom < chartEndDate && validTo >= chartStartDate){
                    var row = [s.FormattedID, s[me.group_field], s.State, s._ValidFrom, s._ValidTo];
                    csv.push(row.join(','));
                }
            });
            csv = csv.join("\r\n");

            CArABU.technicalservices.Exporter.saveCSVToFile(csv, Ext.String.format('export-{0}.csv', Rally.util.DateTime.format(new Date(), 'Y-m-d')));
        }
    }
    
});
