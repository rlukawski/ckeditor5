/**
 * @license Copyright (c) 2003-2023, CKSource Holding sp. z o.o. All rights reserved.
 * For licensing, see LICENSE.md or https://ckeditor.com/legal/ckeditor-oss-license
 */

/**
 * @module html-support/htmlcomment
 */

import type { Marker, Position, Range, Element, ViewRootEditableElement } from 'ckeditor5/src/engine';
import { Plugin } from 'ckeditor5/src/core';
import { uid } from 'ckeditor5/src/utils';

/**
 * The HTML comment feature. It preserves the HTML comments (`<!-- -->`) in the editor data.
 *
 * For a detailed overview, check the {@glink features/html/html-comments HTML comment feature documentation}.
 */
export default class HtmlComment extends Plugin {
	/**
	 * @inheritDoc
	 */
	public static get pluginName(): 'HtmlComment' {
		return 'HtmlComment';
	}

	/**
	 * @inheritDoc
	 */
	public init(): void {
		const editor = this.editor;

		editor.data.processor.skipComments = false;

		// Allow storing comment's content as the $root attribute with the name `$comment:<unique id>`.
		editor.model.schema.addAttributeCheck( ( context, attributeName ) => {
			if ( context.endsWith( '$root' ) && attributeName.startsWith( '$comment' ) ) {
				return true;
			}
		} );

		// Convert the `$comment` view element to `$comment:<unique id>` marker and store its content (the comment itself) as a $root
		// attribute. The comment content is needed in the `dataDowncast` pipeline to re-create the comment node.
		editor.conversion.for( 'upcast' ).elementToMarker( {
			view: '$comment',
			model: ( viewElement, { writer } ) => {
				const rootElement = viewElement.root as ViewRootEditableElement;
				const rootName = rootElement.rootName;
				const root = this.editor.model.document.getRoot( rootName )!;
				const commentContent = viewElement.getCustomProperty( '$rawContent' );
				const markerName = `$comment:${ uid() }`;

				writer.setAttribute( markerName, commentContent, root );

				return markerName;
			}
		} );

		// Convert the `$comment` marker to `$comment` UI element with `$rawContent` custom property containing the comment content.
		editor.conversion.for( 'dataDowncast' ).markerToElement( {
			model: '$comment',
			view: ( modelElement, { writer } ) => {
				const rootNames = this.editor.model.document.getRootNames();
				let root = undefined;
				for ( const rootName of rootNames ) {
					root = this.editor.model.document.getRoot( rootName )!;
					if ( root.hasAttribute( modelElement.markerName ) ) {
						break;
					}
				}

				const markerName = modelElement.markerName;
				const commentContent = root!.getAttribute( markerName );
				const comment = writer.createUIElement( '$comment' );

				writer.setCustomProperty( '$rawContent', commentContent, comment );

				return comment;
			}
		} );

		// Remove comments' markers and their corresponding $root attributes, which are no longer present.
		editor.model.document.registerPostFixer( writer => {
			const changedMarkers = editor.model.document.differ.getChangedMarkers();

			const changedCommentMarkers = changedMarkers.filter( marker => {
				return marker.name.startsWith( '$comment' );
			} );

			const removedCommentMarkers = changedCommentMarkers.filter( marker => {
				const newRange = marker.data.newRange;

				return newRange && newRange.root.rootName === '$graveyard';
			} );

			if ( removedCommentMarkers.length === 0 ) {
				return false;
			}

			for ( const marker of removedCommentMarkers ) {
				let root = undefined;
				if ( marker.data.oldRange ) {
					root = marker.data.oldRange.root as Element;
				} else {
					// In rare cases where marker does not have oldRange set, we need to iterate through all roots.
					for ( const rootName of this.editor.model.document.getRootNames() ) {
						if ( this.editor.model.document.getRoot( rootName )!.hasAttribute( marker.name ) ) {
							root = this.editor.model.document.getRoot( rootName )! as Element;

							break;
						}
					}
				}

				writer.removeMarker( marker.name );
				writer.removeAttribute( marker.name, root! );
			}

			return true;
		} );

		// Delete all comment markers from the document before setting new data.
		editor.data.on( 'set', () => {
			for ( const commentMarker of editor.model.markers.getMarkersGroup( '$comment' ) ) {
				this.removeHtmlComment( commentMarker.name );
			}
		}, { priority: 'high' } );

		// Delete all comment markers that are within a removed range.
		// Delete all comment markers at the limit element boundaries if the whole content of the limit element is removed.
		editor.model.on( 'deleteContent', ( evt, [ selection ] ) => {
			for ( const range of selection.getRanges() ) {
				const limitElement = editor.model.schema.getLimitElement( range );
				const firstPosition = editor.model.createPositionAt( limitElement, 0 );
				const lastPosition = editor.model.createPositionAt( limitElement, 'end' );

				let affectedCommentIDs;

				if ( firstPosition.isTouching( range.start ) && lastPosition.isTouching( range.end ) ) {
					affectedCommentIDs = this.getHtmlCommentsInRange( editor.model.createRange( firstPosition, lastPosition ) );
				} else {
					affectedCommentIDs = this.getHtmlCommentsInRange( range, { skipBoundaries: true } );
				}

				for ( const commentMarkerID of affectedCommentIDs ) {
					this.removeHtmlComment( commentMarkerID );
				}
			}
		}, { priority: 'high' } );
	}

	/**
	 * Creates an HTML comment on the specified position and returns its ID.
	 *
	 * *Note*: If two comments are created at the same position, the second comment will be inserted before the first one.
	 *
	 * @returns Comment ID. This ID can be later used to e.g. remove the comment from the content.
	 */
	public createHtmlComment( position: Position, content: string ): string {
		const id = uid();
		const editor = this.editor;
		const model = editor.model;
		const root = model.document.getRoot( position.root.rootName )!;
		const markerName = `$comment:${ id }`;

		return model.change( writer => {
			const range = writer.createRange( position );

			writer.addMarker( markerName, {
				usingOperation: true,
				affectsData: true,
				range
			} );

			writer.setAttribute( markerName, content, root );

			return markerName;
		} );
	}

	/**
	 * Removes an HTML comment with the given comment ID.
	 *
	 * It does nothing and returns `false` if the comment with the given ID does not exist.
	 * Otherwise it removes the comment and returns `true`.
	 *
	 * Note that a comment can be removed also by removing the content around the comment.
	 *
	 * @param commentID The ID of the comment to be removed.
	 * @returns `true` when the comment with the given ID was removed, `false` otherwise.
	 */
	public removeHtmlComment( commentID: string ): boolean {
		const editor = this.editor;
		const marker = editor.model.markers.get( commentID );

		if ( !marker ) {
			return false;
		}

		editor.model.change( writer => {
			writer.removeMarker( marker );

			for ( const rootName of this.editor.model.document.getRootNames() ) {
				const root = editor.model.document.getRoot( rootName )!;
				if ( root.hasAttribute( commentID ) ) {
					writer.removeAttribute( commentID, root );
					break;
				}
			}
		} );

		return true;
	}

	/**
	 * Gets the HTML comment data for the comment with a given ID.
	 *
	 * Returns `null` if the comment does not exist.
	 *
	 */
	public getHtmlCommentData( commentID: string ): HtmlCommentData | null {
		const editor = this.editor;
		const marker = editor.model.markers.get( commentID );

		if ( !marker ) {
			return null;
		}

		let content = '';
		for ( const rootName of this.editor.model.document.getRootNames() ) {
			const root = editor.model.document.getRoot( rootName )!;
			if ( root.hasAttribute( commentID ) ) {
				content = root.getAttribute( commentID ) as string;
				break;
			}
		}

		return {
			content,
			position: marker.getStart()
		};
	}

	/**
	 * Gets all HTML comments in the given range.
	 *
	 * By default it includes comments at the range boundaries.
	 *
	 * @param range
	 * @param options.skipBoundaries When set to `true` the range boundaries will be skipped.
	 * @returns HTML comment IDs
	 */
	public getHtmlCommentsInRange( range: Range, { skipBoundaries = false } = {} ): Array<string> {
		const includeBoundaries = !skipBoundaries;

		// Unfortunately, MarkerCollection#getMarkersAtPosition() filters out collapsed markers.
		return Array.from( this.editor.model.markers.getMarkersGroup( '$comment' ) )
			.filter( marker => isCommentMarkerInRange( marker, range ) )
			.map( marker => marker.name );

		function isCommentMarkerInRange( commentMarker: Marker, range: Range ) {
			const position = commentMarker.getRange().start;

			return (
				( position.isAfter( range.start ) || ( includeBoundaries && position.isEqual( range.start ) ) ) &&
				( position.isBefore( range.end ) || ( includeBoundaries && position.isEqual( range.end ) ) )
			);
		}
	}
}

/**
 * An interface for the HTML comments data.
 *
 * It consists of the {@link module:engine/model/position~Position `position`} and `content`.
 */
export interface HtmlCommentData {
	position: Position;
	content: string;
}
