import { Observable, lastValueFrom, from, of } from 'rxjs';
import { map, mergeMap } from 'rxjs/operators';

import {
  AbstractQuery,
  AdHocVariableFilter,
  CoreApp,
  DataFrame,
  DataQueryRequest,
  DataQueryResponse,
  DataSourceInstanceSettings,
  DataSourceWithQueryImportSupport,
  getDefaultTimeRange,
  MetricFindValue,
  QueryFixAction,
  ScopedVars,
  TimeRange,
} from '@grafana/data';
import { BucketAggregation, DataLinkConfig, ElasticsearchQuery, TermsQuery, FieldCapabilitiesResponse } from '@/types';
import { 
  DataSourceWithBackend, 
  getTemplateSrv, 
  TemplateSrv } from '@grafana/runtime';
import { QuickwitOptions } from 'quickwit';
import { getDataQuery } from 'QueryBuilder/elastic';

import { metricAggregationConfig } from 'components/QueryEditor/MetricAggregationsEditor/utils';
import { isMetricAggregationWithField } from 'components/QueryEditor/MetricAggregationsEditor/aggregations';
import { bucketAggregationConfig } from 'components/QueryEditor/BucketAggregationsEditor/utils';
import { isBucketAggregationWithField } from 'components/QueryEditor/BucketAggregationsEditor/aggregations';
import ElasticsearchLanguageProvider from 'LanguageProvider';
import { fieldTypeMap } from 'utils';
import { addAddHocFilter } from 'modifyQuery';
import { getQueryResponseProcessor } from 'datasource/processResponse';

import { SECOND } from 'utils/time';
import { GConstructor } from 'utils/mixins';

export type BaseQuickwitDataSourceConstructor = GConstructor<BaseQuickwitDataSource>

type FieldCapsSpec = {
  aggregatable?: boolean,
  searchable?: boolean,
  type?: string[],
  _range?: TimeRange
}

export class BaseQuickwitDataSource
  extends DataSourceWithBackend<ElasticsearchQuery, QuickwitOptions>
  implements
    DataSourceWithQueryImportSupport<ElasticsearchQuery>
{
  index: string;
  timeField: string;
  logMessageField?: string;
  logLevelField?: string;
  dataLinks: DataLinkConfig[];
  languageProvider: ElasticsearchLanguageProvider;


  constructor(
    instanceSettings: DataSourceInstanceSettings<QuickwitOptions>,
    private readonly templateSrv: TemplateSrv = getTemplateSrv()
    ) {
    super(instanceSettings);
    const settingsData = instanceSettings.jsonData || ({} as QuickwitOptions);
    this.index = settingsData.index || '';
    this.timeField = ''
    this.logMessageField = settingsData.logMessageField || '';
    this.logLevelField = settingsData.logLevelField || '';
    this.dataLinks = settingsData.dataLinks || [];
    this.languageProvider = new ElasticsearchLanguageProvider(this);
  }

  query(request: DataQueryRequest<ElasticsearchQuery>): Observable<DataQueryResponse> {
    const queryProcessor = getQueryResponseProcessor(this, request)
     return super.query(request) .pipe(map(queryProcessor.processResponse));
  }

    /**
     * Checks the plugin health
     * see public/app/features/datasources/state/actions.ts for what needs to be returned here
     */
  async testDatasource() {
    if (this.index === '' ) {
      return {
        status: 'error',
        message: 'Cannot save datasource, `index` is required',
      };
    }
    const backendCheck = from(this.callHealthCheck()).pipe(
      mergeMap((res) => {
        return of({
          status: res.status.toLowerCase(),
          message: res.message
        })
      })
    )

    return lastValueFrom(backendCheck)
  }

  async importFromAbstractQueries(abstractQueries: AbstractQuery[]): Promise<ElasticsearchQuery[]> {
    // FIXME: this function does not seem to be used.
    return abstractQueries.map((abstractQuery) => this.languageProvider.importFromAbstractQuery(abstractQuery));
  }

  /**
   * Used in explore when user filters on a given log attribute.
   */
  modifyQuery(query: ElasticsearchQuery, action: QueryFixAction): ElasticsearchQuery {
    if (!action.options) {
      return query;
    }

    let expression = query.query ?? '';
    switch (action.type) {
      case 'ADD_FILTER': {
        if (expression.length > 0) {
          expression += ' AND ';
        }
        expression += `${action.options.key}:"${action.options.value}"`;
        break;
      }
      case 'ADD_FILTER_OUT': {
        if (expression.length > 0) {
          expression += ' AND ';
        }
        expression += `-${action.options.key}:"${action.options.value}"`;
        break;
      }
    }
    return { ...query, query: expression };
  }

  getDataQueryRequest(queryDef: TermsQuery, range: TimeRange) {
    let dataQuery = getDataQuery(queryDef, 'getTerms');
    const request: DataQueryRequest = {
      app: CoreApp.Unknown,
      requestId: 'GetTerms',
      interval: '',
      intervalMs: 0,
      range,
      targets:[dataQuery],
      timezone:'browser',
      scopedVars:{},
      startTime: Date.now(),
    }
    return request
  }

  getTerms(queryDef: TermsQuery, range = getDefaultTimeRange()): Observable<MetricFindValue[]> {
    const dataquery = this.getDataQueryRequest(queryDef, range)
    return super.query(dataquery).pipe(
      mergeMap(res=> {
        return res.data.map((df: DataFrame)=>{
          if (df.fields.length === 0) { return [] }
          return df.fields[0].values.map((bucket)=>({
            text: bucket,
            value: bucket,
          }))
        })
      })
    )
  }

  getFields(spec: FieldCapsSpec={}, range = getDefaultTimeRange()): Observable<MetricFindValue[]> {
    return from(this.getResource('_elastic/' + this.index + '/_field_caps', {
      start_timestamp: Math.floor(range.from.valueOf()/SECOND),
      end_timestamp: Math.ceil(range.to.valueOf()/SECOND),
    })).pipe(
      map((field_capabilities_response: FieldCapabilitiesResponse) => {
        const shouldAddField = (field: any) => {
          if (spec.aggregatable !== undefined && field.aggregatable !== spec.aggregatable) {
            return false
          }
          if (spec.searchable !== undefined && field.searchable !== spec.searchable){
            return false
          }
          if (spec.type && spec.type.length !== 0 && !(spec.type.includes(field.type) || spec.type.includes(fieldTypeMap[field.type]))) {
            return false
          }
          return true
        };
        const fieldCapabilities = Object.entries(field_capabilities_response.fields)
          .flatMap(([field_name, field_capabilities]) => {
            return Object.values(field_capabilities)
              .map(field_capability => {
                field_capability.field_name = field_name;
                return field_capability;
              });
          })
          .filter(shouldAddField)
          .map(field_capability => {
            return {
              text: field_capability.field_name,
              value: fieldTypeMap[field_capability.type],  
            }
          });
        const uniquefieldCapabilities = fieldCapabilities.filter((field_capability, index, self) =>
          index === self.findIndex((t) => (
            t.text === field_capability.text && t.value === field_capability.value
          ))
        ).sort((a, b) => a.text.localeCompare(b.text));
        return uniquefieldCapabilities;
      })
    );
  }

  /**
   * Get tag keys for adhoc filters
   */
  getTagKeys(spec?: FieldCapsSpec) {
    const fields = this.getFields(spec)
    return lastValueFrom(fields, {defaultValue:[]});
  }

  /**
   * Get tag values for adhoc filters
   */
  getTagValues(options: any) {
    const range = getDefaultTimeRange();
    const terms = this.getTerms({ field: options.key }, range)
    return lastValueFrom(terms, {defaultValue:[]});
  }

  /**
   * Convert a query to a simple text string
   */
  getQueryDisplayText(query: ElasticsearchQuery) {
    // TODO: This might be refactored a bit.
    const metricAggs = query.metrics;
    const bucketAggs = query.bucketAggs;
    let text = '';

    if (query.query) {
      text += 'Query: ' + query.query + ', ';
    }

    text += 'Metrics: ';

    text += metricAggs?.reduce((acc, metric) => {
      const metricConfig = metricAggregationConfig[metric.type];

      let text = metricConfig.label + '(';

      if (isMetricAggregationWithField(metric)) {
        text += metric.field;
      }
      text += '), ';

      return `${acc} ${text}`;
    }, '');

    text += bucketAggs?.reduce((acc, bucketAgg, index) => {
      const bucketConfig = bucketAggregationConfig[bucketAgg.type];

      let text = '';
      if (index === 0) {
        text += ' Group by: ';
      }

      text += bucketConfig.label + '(';
      if (isBucketAggregationWithField(bucketAgg)) {
        text += bucketAgg.field;
      }

      return `${acc} ${text}), `;
    }, '');

    if (query.alias) {
      text += 'Alias: ' + query.alias;
    }

    return text;
  }


  /**
   * Returns false if the query should be skipped
   */
  filterQuery(query: ElasticsearchQuery): boolean {
    if (query.hide) {
      return false;
    }
    return true;
  }

  metricFindQuery(query: string, options?: { range: TimeRange }): Promise<MetricFindValue[]> {
    const range = options?.range;
    const parsedQuery = JSON.parse(query);
    if (query) {
      if (parsedQuery.find === 'fields') {
        parsedQuery.type = this.interpolateLuceneQuery(parsedQuery.type);
        return lastValueFrom(this.getFields({aggregatable:true, type:parsedQuery.type, _range:range}), {defaultValue:[]});
      }
      if (parsedQuery.find === 'terms') {
        parsedQuery.field = this.interpolateLuceneQuery(parsedQuery.field);
        parsedQuery.query = this.interpolateLuceneQuery(parsedQuery.query);
        return lastValueFrom(this.getTerms(parsedQuery, range), {defaultValue:[]});
      }
    }
    return Promise.resolve([]);
  }

  interpolateLuceneQuery(queryString: string, scopedVars?: ScopedVars) {
    return this.templateSrv.replace(queryString, scopedVars, formatQuery);
  }

  interpolateVariablesInQueries(queries: ElasticsearchQuery[], scopedVars: ScopedVars | {}, filters?: AdHocVariableFilter[]): ElasticsearchQuery[] {
    return queries.map((q) => this.applyTemplateVariables(q, scopedVars, filters));
  }

  // Used when running queries through backend
  applyTemplateVariables(query: ElasticsearchQuery, scopedVars: ScopedVars, filters?: AdHocVariableFilter[]): ElasticsearchQuery {
    // We need a separate interpolation format for lucene queries, therefore we first interpolate any
    // lucene query string and then everything else
    const interpolateBucketAgg = (bucketAgg: BucketAggregation): BucketAggregation => {
      if (bucketAgg.type === 'filters') {
        return {
          ...bucketAgg,
          settings: {
            ...bucketAgg.settings,
            filters: bucketAgg.settings?.filters?.map((filter) => ({
              ...filter,
              query: this.interpolateLuceneQuery(filter.query, scopedVars) || '*',
            })),
          },
        };
      }

      return bucketAgg;
    };

    const expandedQuery = {
      ...query,
      datasource: this.getRef(),
      query: this.addAdHocFilters(this.interpolateLuceneQuery(query.query || '', scopedVars), filters),
      bucketAggs: query.bucketAggs?.map(interpolateBucketAgg),
    };

    const finalQuery = JSON.parse(this.templateSrv.replace(JSON.stringify(expandedQuery), scopedVars));
    return finalQuery;
  }

  addAdHocFilters(query: string, adhocFilters?: AdHocVariableFilter[]) {
    if (!adhocFilters) {
      return query;
    }
    let finalQuery = query;
    adhocFilters.forEach((filter) => {
      finalQuery = addAddHocFilter(finalQuery, filter);
    });

    return finalQuery;
  }
}
function formatQuery(value: string | string[], variable: any): string {
  if (typeof value === 'string') {
    return luceneEscape(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '__empty__';
    }
    const fieldName = JSON.parse(variable.query).field;
    const quotedValues =  value.map((val) => '"' + luceneEscape(val) + '"');
    // Quickwit query language does not support fieldName:(value1 OR value2 OR....)
    // like lucene does.
    // When we know the fieldName, we can directly generate a query
    // fieldName:value1 OR fieldName:value2 OR ...
    // But when we don't know the fieldName, the simplest is to generate a query
    // with the IN operator. Unfortunately, IN operator does not work on JSON field.
    // TODO: fix that by using doing a regex on queryString to find the fieldName.
    // Note that variable.id gives the name of the template variable to interpolate,
    // so if we have `fieldName:${variable.id}` in the queryString, we can isolate
    // the fieldName.
    if (typeof fieldName !== 'string') {
      return 'IN [' + quotedValues.join(' ') + ']';
    }
    return quotedValues.join(' OR ' + fieldName + ':');
  } else {
    return luceneEscape(`${value}`);
  }
}

function luceneEscape(value: string) {
  if (isNaN(+value) === false) {
    return value;
  }

  return value.replace(/([\!\*\+\-\=<>\s\&\|\(\)\[\]\{\}\^\~\?\:\\/"])/g, '\\$1');
}