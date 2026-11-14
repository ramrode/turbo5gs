/*
 * CHF subscriber quota-profile collection.
 *
 * Scale hardening for a large provisioned-subscriber base:
 *   - Server-side pagination (?limit/?skip, sorted by SUPI): only one page is
 *     ever fetched and rendered, never the whole chf.subscribers collection.
 *   - Server-side SUPI search (?query, prefix-anchored + regex-escaped) so an
 *     operator finds one subscriber among thousands without downloading them.
 *   - X-Total-Count drives an "N of TOTAL" indicator and the Next control.
 *
 * Structure: a stateful, connected parent owns page/search + the create /
 * edit / delete modals; a connected child selects exactly the page named by
 * queryParams (a page/search change flips crud "needsFetch" and refetches).
 *
 * Copyright (C) 2026 by Rami Mohamed <ramrode@gmail.com>
 */

import { Component } from 'react';
import PropTypes from 'prop-types';
import { connect } from 'react-redux';

import {
  MODEL,
  fetchChfSubscribers,
  deleteChfSubscriber,
} from 'modules/crud/chf-subscriber';
import { clearActionStatus } from 'modules/crud/actions';
import { select, selectActionStatus } from 'modules/crud/selectors';
import { buildSubscriberParams, totalFromOtherInfo } from 'helpers/chf-query';
import * as Notification from 'modules/notification/actions';

import {
  Layout,
  ChfSubscriber,
  Spinner,
  FloatingButton,
  Blank,
  Dimmed,
  Confirm,
  ListToolbar,
} from 'components';
import ChfStats from 'containers/ChfStats';

import Document from './Document';

const PAGE_SIZE = 25;
const SEARCH_DEBOUNCE_MS = 400;

/* ------------------------------------------------------------------ */
/* Connected data view — selects and renders one page of subscribers.  */
/* ------------------------------------------------------------------ */
class SubscriberData extends Component {
  componentWillMount() {
    this.maybeFetch(this.props);
  }

  componentWillReceiveProps(nextProps) {
    this.maybeFetch(nextProps);
  }

  maybeFetch(props) {
    /* Only fetch a page when the view is active (a search or Browse) —
     * the default landing is stats-only and must not pull the collection. */
    if (props.active && props.chfSubscribers.needsFetch) {
      props.dispatch(props.chfSubscribers.fetch);
    }
  }

  render() {
    const {
      active, chfSubscribers, deletedSupi, onEdit, onDelete, onBrowse,
      page, pageSize, search, onSearchChange, onPrev, onNext,
    } = this.props;
    const { isLoading, data, otherInfo } = chfSubscribers;
    const total = totalFromOtherInfo(otherInfo);

    return (
      <div>
        <ListToolbar
          showSearch
          search={search}
          searchPlaceholder="Search by SUPI or prefix (e.g. imsi-99970 …)"
          onSearchChange={onSearchChange}
          page={page}
          pageSize={pageSize}
          count={active ? data.length : 0}
          total={active ? total : undefined}
          onPrev={onPrev}
          onNext={onNext}
        />

        {!active ? (
          <Blank
            visible
            title="BROWSE ALL SUBSCRIBERS"
            body="Search by SUPI (or a prefix) above, or browse the full list."
            onTitle={onBrowse}
          />
        ) : (
          <div>
            <ChfSubscriber.List
              chfSubscribers={data}
              deletedSupi={deletedSupi}
              onEdit={onEdit}
              onDelete={onDelete}
            />
            {isLoading && <Spinner md />}
            <Blank
              visible={!isLoading && !(data.length > 0)}
              title="NO MATCHING SUBSCRIBERS"
              body="No CHF quota profiles match this view."
            />
          </div>
        )}
      </div>
    );
  }
}

SubscriberData.propTypes = {
  active: PropTypes.bool.isRequired,
  chfSubscribers: PropTypes.object.isRequired,
  dispatch: PropTypes.func.isRequired,
  deletedSupi: PropTypes.string,
  onEdit: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
  onBrowse: PropTypes.func.isRequired,
  page: PropTypes.number.isRequired,
  pageSize: PropTypes.number.isRequired,
  search: PropTypes.string.isRequired,
  onSearchChange: PropTypes.func.isRequired,
  onPrev: PropTypes.func.isRequired,
  onNext: PropTypes.func.isRequired,
};

const ConnectedSubscriberData = connect((state, ownProps) => ({
  chfSubscribers: select(fetchChfSubscribers(ownProps.queryParams), state.crud),
}))(SubscriberData);

/* ------------------------------------------------------------------ */
/* Stateful parent — owns page/search + create/edit/delete modals.     */
/* ------------------------------------------------------------------ */
class Collection extends Component {
  state = {
    page: 0,
    searchInput: '',
    searchApplied: '',
    browse: false,   // "Browse all" was clicked (list without a search)
    document: {
      action: '',
      visible: false,
      dimmed: false,
    },
    confirm: {
      visible: false,
      /* The bucket to delete: a SUPI for a subscriber's catch-all, or a
       * scoped bucket's own id. */
      bucketId: '',
    },
  };

  componentWillUnmount() {
    if (this._searchTimer) clearTimeout(this._searchTimer);
  }

  componentWillReceiveProps(nextProps) {
    const { status } = nextProps;
    const { dispatch } = this.props;

    if (status.response) {
      dispatch(
        Notification.success({
          title: 'CHF Quota',
          message: `${status.id} has been deleted`,
        })
      );
      dispatch(clearActionStatus(MODEL, 'delete'));
      /* Refresh the current page so the deleted row disappears. */
      dispatch(fetchChfSubscribers(this.params()));
    }

    if (status.error) {
      const response = ((status || {}).error || {}).response || {};
      let title = 'Unknown Code';
      let message = 'Unknown Error';
      if (response.data && response.data.name && response.data.message) {
        title = response.data.name;
        message = response.data.message;
      } else {
        title = response.status;
        message = response.statusText;
      }
      dispatch(
        Notification.error({
          title,
          message,
          autoDismiss: 0,
          action: { label: 'Dismiss' },
        })
      );
      dispatch(clearActionStatus(MODEL, 'delete'));
    }
  }

  params() {
    return buildSubscriberParams(
      this.state.page, PAGE_SIZE, this.state.searchApplied);
  }

  isActive() {
    return this.state.searchApplied !== '' || this.state.browse;
  }

  handleSearchChange = (value) => {
    this.setState({ searchInput: value });
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => {
      this.setState({ searchApplied: value.trim(), page: 0 });
    }, SEARCH_DEBOUNCE_MS);
  };

  handleBrowse = () => this.setState({ browse: true, page: 0 });

  handlePrev = () => this.setState(s => ({ page: Math.max(0, s.page - 1) }));
  handleNext = () => this.setState(s => ({ page: s.page + 1 }));

  documentHandler = {
    show: (action, payload) => {
      this.setState({
        document: { action, visible: true, dimmed: true, ...payload },
      });
    },
    hide: () => {
      /* Refresh the page after a create/edit so new/changed rows show. */
      this.props.dispatch(fetchChfSubscribers(this.params()));
      this.setState({
        document: { action: '', visible: false, dimmed: false },
      });
    },
    actions: {
      create: () => {
        this.documentHandler.show('create');
      },
      update: bucketId => {
        this.documentHandler.show('update', { bucketId });
      },
    },
  };

  confirmHandler = {
    show: bucketId => {
      this.setState({ confirm: { visible: true, bucketId } });
    },
    hide: () => {
      this.setState({
        confirm: { ...this.state.confirm, visible: false },
      });
    },
    actions: {
      delete: () => {
        const { dispatch } = this.props;
        if (this.state.confirm.visible === true) {
          this.confirmHandler.hide();
          this.documentHandler.hide();
          dispatch(deleteChfSubscriber(this.state.confirm.bucketId));
        }
      },
    },
  };

  render() {
    const { documentHandler, confirmHandler } = this;
    const { document } = this.state;
    const { status } = this.props;

    return (
      <Layout.Content>
        <ChfStats windowHours={1} />
        <ConnectedSubscriberData
          active={this.isActive()}
          queryParams={this.params()}
          page={this.state.page}
          pageSize={PAGE_SIZE}
          search={this.state.searchInput}
          dispatch={this.props.dispatch}
          deletedSupi={status.id}
          onEdit={documentHandler.actions.update}
          onDelete={confirmHandler.show}
          onBrowse={this.handleBrowse}
          onSearchChange={this.handleSearchChange}
          onPrev={this.handlePrev}
          onNext={this.handleNext}
        />
        <FloatingButton onClick={documentHandler.actions.create} />
        <Document
          {...document}
          onEdit={documentHandler.actions.update}
          onDelete={confirmHandler.show}
          onHide={documentHandler.hide}
        />
        <Dimmed visible={document.dimmed} />
        <Confirm
          visible={this.state.confirm.visible}
          message="Delete this CHF quota profile?"
          onOutside={confirmHandler.hide}
          buttons={[
            { text: 'CANCEL', action: confirmHandler.hide, info: true },
            { text: 'DELETE', action: confirmHandler.actions.delete, danger: true },
          ]}
        />
      </Layout.Content>
    );
  }
}

Collection.propTypes = {
  dispatch: PropTypes.func.isRequired,
  status: PropTypes.object.isRequired,
};

Collection = connect((state) => ({
  status: selectActionStatus(MODEL, state.crud, 'delete'),
}))(Collection);

export default Collection;
