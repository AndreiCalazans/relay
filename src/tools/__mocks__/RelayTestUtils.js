/**
 * Copyright 2013-2015, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 */

'use strict';

/**
 * Utility methods (eg. for unmocking Relay internals) and custom Jasmine
 * matchers.
 */
var RelayTestUtils = {
  /**
   * Returns true if `query` contains a node that equals the `target` node
   */
  containsNode(query, target) {
    function find(node) {
      if (node.equals(target)) {
        return true;
      }
      var children = node.getChildren();
      return children.length > 0 && children.some(find);
    }
    return find(query);
  },

  createRenderer(container) {
    var React = require('React');
    var ReactDOM = require('ReactDOM');
    var RelayPropTypes = require('RelayPropTypes');
    var RelayRoute = require('RelayRoute');

    class ContextSetter extends React.Component {
      getChildContext() {
        return this.props.context;
      }
      render() {
        return this.props.render();
      }
    }
    ContextSetter.childContextTypes = {
      route: RelayPropTypes.QueryConfig.isRequired,
    };

    class MockPointer {
      constructor(dataID) {
        this.dataID = dataID;
      }
    }

    container = container || document.createElement('div');

    return {
      render(render, route) {
        route = route || RelayRoute.genMockInstance();

        var result;
        function ref(component) {
          result = component;
        }
        ReactDOM.render(
          <ContextSetter
            context={{route}}
            render={() => {
              var element = render(dataID => new MockPointer(dataID));
              var pointers = {};
              for (var propName in element.props) {
                var propValue = element.props[propName];
                if (propValue instanceof MockPointer) {
                  var fragmentReference = element.type.getFragment(propName);
                  if (fragmentReference == null) {
                    throw new Error(
                      'Query not found, `' + element.type.displayName + '.' +
                      propName + '`.'
                    );
                  }
                  pointers[propName] = RelayTestUtils.getPointer(
                    propValue.dataID,
                    RelayTestUtils.getNode(fragmentReference.getFragment({}))
                  );
                }
              }
              return React.cloneElement(element, {...pointers, ref});
            }}
          />,
          container
        );
        return result;
      }
    };
  },

  conditionOnType(fragment) {
    var QueryBuilder = require('QueryBuilder');
    var RelayFragmentReference = require('RelayFragmentReference');
    var invariant = require('invariant');

    invariant(
      !!QueryBuilder.getFragment(fragment),
      'conditionOnType(): Argument must be a GraphQL.QueryFragment.'
    );
    var reference = new RelayFragmentReference(
      () => fragment,
      {}
    );
    reference.conditionOnType();
    return reference;
  },

  createCall(name, value) {
    var QueryBuilder = require('QueryBuilder');

    if (Array.isArray(value)) {
      value = value.map(QueryBuilder.createCallValue);
    } else if (value != null) {
      value = QueryBuilder.createCallValue(value);
    }
    return QueryBuilder.createCall(name, value);
  },

  defer(fragment) {
    var QueryBuilder = require('QueryBuilder');
    var RelayFragmentReference = require('RelayFragmentReference');
    var invariant = require('invariant');

    invariant(
      !!QueryBuilder.getFragment(fragment),
      'defer(): Argument must be a GraphQL.QueryFragment.'
    );
    var reference = new RelayFragmentReference(
      () => fragment,
      {}
    );
    reference.defer();
    return reference;
  },

  getNode(node, variables) {
    var RelayMetaRoute = require('RelayMetaRoute');
    var RelayQuery = require('RelayQuery');

    var route = RelayMetaRoute.get('$RelayTestUtils');
    return RelayQuery.Node.create(node, route, variables || {});
  },

  getPointer(dataID, fragment) {
    var GraphQLFragmentPointer = require('GraphQLFragmentPointer');
    var RelayQuery = require('RelayQuery');
    var invariant = require('invariant');

    invariant(
      fragment instanceof RelayQuery.Fragment,
      'getPointer(): expected a `RelayQueryFragment`, got `%s`.',
      fragment.constructor.name
    );

    var fragmentPointer = new GraphQLFragmentPointer(dataID, fragment);
    return {[fragment.getConcreteFragmentID()]: fragmentPointer};
  },

  /**
   * Convenience method for turning `node` into a properly formed ref query. We
   * can't produce one of these solely with `Relay.QL`, so we use a node from
   * `Relay.QL` as a basis and attach the appropriate args and ref params.
   */
  getRefNode(node, refParam) {
    var QueryBuilder = require('QueryBuilder');
    var RelayQuery = require('RelayQuery');
    var RelayMetaRoute = require('RelayMetaRoute');

    var invariant = require('invariant');

    invariant(
      node.fieldName === 'nodes',
     'getRefNode(): Ref queries require `nodes()` roots.'
    );
    var callValue = Array.isArray(node.calls[0].value) ?
      node.calls[0].value[0] :
      node.calls[0].value;
    invariant(
      !!QueryBuilder.getCallVariable(callValue),
      'getRefNode(): Expected a batch call variable, got `%s`.',
      JSON.stringify(callValue)
    );
    var name = callValue.callVariableName;
    var match = name.match(/^ref_(q\d+)$/);
    invariant(
      match,
      'getRefNode(): Expected call variable of the form `<ref_q\\d+>`.'
    );
    // e.g. `q0`
    var id = match[1];
    // e.g. `{ref_q0: '<ref_q0>'}`
    var variables = {[name]: '<' + callValue.callVariableName + '>'};

    return RelayQuery.Root.create(
      {
        ...node,
        calls: [QueryBuilder.createCall(
          'id',
          QueryBuilder.createBatchCallVariable(id, refParam.path)
        )],
        isDeferred: true,
      },
      RelayMetaRoute.get('$RelayTestUtils'),
      variables
    );
  },

  getVerbatimNode(node, variables) {
    return RelayTestUtils.filterGeneratedFields(
      RelayTestUtils.getNode(node, variables)
    );
  },

  filterGeneratedFields(query) {
    var RelayQuery = require('RelayQuery');
    var filterRelayQuery = require('filterRelayQuery');

    return filterRelayQuery(
      query,
      node => !(node instanceof RelayQuery.Field && node.isGenerated())
    );
  },

  matchers: {

    /**
     * Checks if a RelayQuery.Root is `===` to another.
     */
    toBeQueryRoot() {
      return {
        compare(actual, expected) {
          var RelayQuery = require('RelayQuery');
          var queryType = checkQueryType(actual, expected, RelayQuery.Root);
          if (!queryType.pass) {
            return queryType;
          }
          return checkQueryEquality(actual, expected, true);
        },
      };
    },

    /**
     * Checks that `warning` was invoked with a falsey condition with expected
     * arguments the supplied number of times. Example usage:
     *
     *   warning(false, "format", "x", "y");
     *   warning(false, "format", "x", "z");
     *
     *   expect(["format", "x", "y"]).toBeWarnedNTimes(1);
     *   expect(["format", "x", "z"]).toBeWarnedNTimes(1);
     *   expect(["format", "x"]).toBeWarnedNTimes(2);
     *
     *   warning(false, "format", "y");
     *
     *   expect(["format", "y"]).toBeWarnedNTimes(1);
     *
     *   warning(true, "format", "z");
     *
     *   expect(["format", "z"]).toBeWarnedNTimes(0);
     *
     *   expect(["format"]).toBeWarnedNTimes(3);
     *
     */
    toBeWarnedNTimes() {
      return {
        compare(actual, expectedCount) {
          var warning = require('warning');
          if (!warning.mock) {
            throw new Error(
              'expect(...).toBeWarnedNTimes(): Requires ' +
              '`jest.mock(\'warning\');`.'
            );
          }
          var expectedArgs = actual;
          if (!Array.isArray(expectedArgs)) {
            throw new Error(
              'expect(...).toBeWarnedNTimes(): Requires an array of ' +
              'warning args.'
            );
          }
          var [format, ...values] = expectedArgs;
          if (!format) {
            throw new Error(
              'expect(...).toBeWarnedNTimes(): Requires a format string.'
            );
          }

          var callsWithExpectedFormatButArgs = [];
          var callsWithExpectedArgs = warning.mock.calls.filter(args => {
            if (args[0] ||
                args[1] !== format) {
              return false;
            }
            if (values.some((value, ii) => value !== args[ii + 2])) {
              callsWithExpectedFormatButArgs.push(args.slice(1));
              return false;
            }
            return true;
          });

          var message =
            'Expected to warn ' + expectedCount + ' time' +
            (expectedCount === 1 ? '' : 's') + ' with arguments: ' +
            JSON.stringify(expectedArgs) + '.';
          var unexpectedCount = callsWithExpectedFormatButArgs.length;
          if (unexpectedCount) {
            message += ' Instead, called ' + unexpectedCount +
            ' time' + (unexpectedCount === 1 ? '' : 's') + ' with arguments: ' +
            JSON.stringify(callsWithExpectedFormatButArgs) + '.';
          }

          return {
            pass: callsWithExpectedArgs.length === expectedCount,
            message,
          };
        },
      };
    },

    /**
     * Checks if a query node contains a node that `equals()` another.
     */
    toContainQueryNode() {
      return {
        compare(actual, expected) {
          if (!RelayTestUtils.containsNode(actual, expected)) {
            return {
              pass: false,
              message: printQueryComparison(
                actual,
                expected,
                'to contain query node'
              ),
            };
          }
          return {
            pass: true,
          };
        },
      };
    },

    toEqualPrintedQuery() {
      return {
        compare(actual, expected) {
          var minifiedActual = RelayTestUtils.minifyQueryText(actual);
          var minifiedExpected = RelayTestUtils.minifyQueryText(expected);

          if (minifiedActual !== minifiedExpected) {
            return {
              pass: false,
              message: [
                minifiedActual,
                'to equal',
                minifiedExpected,
              ].join('\n'),
            };
          }
          return {
            pass: true,
          };
        },
      };
    },

    /**
     * Checks if a RelayQuery.Node is `equals()` to another.
     */
    toEqualQueryNode() {
      return {
        compare(actual, expected) {
          var RelayQuery = require('RelayQuery');
          var queryType = checkQueryType(actual, expected, RelayQuery.Node);
          if (!queryType.pass) {
            return queryType;
          }
          return checkQueryEquality(actual, expected, false);
        },
      };
    },

    /**
     * Checks if a RelayQuery.Root is `equals()` to another.
     */
    toEqualQueryRoot() {
      return {
        compare(actual, expected) {
          var RelayQuery = require('RelayQuery');
          var queryType = checkQueryType(actual, expected, RelayQuery.Root);
          if (!queryType.pass) {
            return queryType;
          }
          return checkQueryEquality(actual, expected, false);
        },
      };
    },

    toFailInvariant() {
      return {
        compare(actual, expected) {
          expect(actual).toThrowError(expected);
          return {
            pass: true,
          };
        },
      };
    },

    /**
     * Compares a query path with another path. Succeeds when the paths are of
     * the same length have equivalent (shallow-equal) roots and fields.
     */
    toMatchPath() {
      return {
        compare(actual, expected) {
          var QueryBuilder = require('QueryBuilder');
          var RelayMetaRoute = require('RelayMetaRoute');
          var RelayQuery = require('RelayQuery');
          var RelayQueryPath = require('RelayQueryPath');

          var invariant = require('invariant');
          var flattenRelayQuery = require('flattenRelayQuery');
          var printRelayQuery = require('printRelayQuery');

          invariant(
            expected && expected instanceof RelayQueryPath,
            'expect(...).toMatchPath(): Argument must be a RelayQueryPath.'
          );
          if (!(actual instanceof RelayQueryPath)) {
            var name = actual ? actual.constructor.name : actual;
            return {
              pass: false,
              message: `expected instance of RelayQueryPath but got [${name}]`,
            };
          }
          var fragment = RelayQuery.Fragment.create(
            QueryBuilder.createFragment({
              children: [QueryBuilder.createField({
                fieldName: '__test__',
              })],
              name: 'Test',
              type: 'Node',
            }),
            RelayMetaRoute.get('$RelayTestUtils'),
            {}
          );
          var actualQuery = flattenRelayQuery(actual.getQuery(fragment));
          var expectedQuery = flattenRelayQuery(expected.getQuery(fragment));

          if (!actualQuery.equals(expectedQuery)) {
            return {
              pass: false,
              message: [
                'Expected:',
                '  ' + printRelayQuery(actualQuery).text,
                '\ntoMatchPath:',
                '  ' + printRelayQuery(expectedQuery).text,
              ].filter(token => token).join('\n'),
            };
          }
          return {
            pass: true,
          };
        },
      };
    },
  },

  /**
   * Returns a version of the query text with extraneous whitespace removed.
   */
  minifyQueryText(queryText) {
    return queryText
      .replace(/\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s*([\{\}\(\):,])\s*/g, '$1')
      .trim();
  },

  unmockRelayForFB() {
    RelayTestUtils.unmockRelay();
    global.__RELAYOSS__ = false;
  },

  unmockRelay() {
    global.__RELAYOSS__ = true;
    jest
      // Utilities
      .dontMock('areEqual')

      // Legacy modules
      .dontMock('GraphQLMutatorConstants')
      .dontMock('GraphQLStoreDataHandler')
      .dontMock('GraphQLStoreRangeUtils')
      .dontMock('generateClientEdgeID');
  },

  /**
   * Helper to write the result payload of a (root) query into a store,
   * returning created/updated ID sets. The payload is transformed before
   * writing; property keys are rewritten from application names into
   * serialization keys matching the fields in the query.
   */
  writePayload(store, query, payload, tracker, options) {
    var transformRelayQueryPayload = require('transformRelayQueryPayload');

    return RelayTestUtils.writeVerbatimPayload(
      store,
      query,
      transformRelayQueryPayload(query, payload),
      tracker,
      options
    );
  },

  /**
   * Helper to write the result payload into a store. Unlike `writePayload`,
   * the payload is not transformed first.
   */
  writeVerbatimPayload(store, query, payload, tracker, options) {
    var RelayChangeTracker = require('RelayChangeTracker');
    var RelayQueryTracker = require('RelayQueryTracker');
    var RelayQueryWriter = require('RelayQueryWriter');
    var writeRelayQueryPayload = require('writeRelayQueryPayload');

    tracker = tracker || new RelayQueryTracker();
    options = options || {};
    var changeTracker = new RelayChangeTracker();
    var writer = new RelayQueryWriter(
      store,
      tracker,
      changeTracker,
      options
    );
    writeRelayQueryPayload(
      writer,
      query,
      payload,
    );
    return changeTracker.getChangeSet();
  },
};

/**
 * @private
 */
function checkQueryType(actual, expected, ExpectedClass) {
  var expectedType = ExpectedClass.name;
  if (!(expected && expected instanceof ExpectedClass)) {
    throw new Error('expect(...): Requires a `' + expectedType + '`.');
  }
  if (!(actual instanceof ExpectedClass)) {
    var actualType = actual;
    if (actual && actual.constructor) {
      actualType = actual.constructor.name;
    }
    return {
      pass: false,
      message: 'Expected a `' + expectedType + '`, got `' + actualType + '`.',
    };
  }
  return {
    pass: true,
  };
}

/**
 * @private
 */
function checkQueryEquality(actual, expected, toBe) {
  var flatActual = sortRelayQuery(actual);
  var flatExpected = sortRelayQuery(expected);

  if (toBe ? (actual !== expected) : (!flatActual.equals(flatExpected))) {
    return {
      pass: false,
      message: printQueryComparison(
        actual,
        expected,
        toBe ? 'to be query' : 'to equal query'
      ),
    };
  }

  return {
    pass: true,
  };
}

/**
 * @private
 */
function printQueryComparison(actual, expected, message) {
  var printRelayQuery = require('printRelayQuery');

  var formatRefParam = node => node.hasRefParam && node.hasRefParam() ?
      '  [ref param: ' + JSON.stringify(node.getRefParam()) + ']' :
      null;

  return [
    'Expected:',
    '  ' + printRelayQuery(actual).text,
    formatRefParam(actual),
    message + ':',
    '  ' + printRelayQuery(expected).text,
    formatRefParam(expected),
  ].filter(line => !!line).join('\n');
}

/**
 * @private
 */
function sortRelayQuery(node) {
  var RelayQuery = require('RelayQuery');

  function getID(node) {
    return node instanceof RelayQuery.Fragment ?
      node.getFragmentID() :
      node.getSerializationKey();
  }
  function compare(a, b) {
    if (a === b) {
      return 0;
    } else if (a < b) {
      return -1;
    } else {
      return 1;
    }
  }

  return node.clone(node.getChildren().sort((a, b) => {
    var aID = getID(a);
    var bID = getID(b);
    return compare(aID, bID);
  }).map(sortRelayQuery));
}

module.exports = RelayTestUtils;